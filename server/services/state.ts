import { createHash } from 'node:crypto'
import { ulid } from 'ulid'
import { eq, desc } from 'drizzle-orm'
import { db } from '../db/client'
import { stateVersion, projectState } from '../db/schema'
import { store } from '../storage'
import { currentLock } from './lock'
import { seal, open } from '../utils/crypto'
import { env } from '../utils/env'

export type StateVersionRow = typeof stateVersion.$inferSelect

function blobKey(orgSlug: string, projectSlug: string, versionId: string): string {
  return `${orgSlug}/${projectSlug}/${versionId}.tfstate.enc`
}

// Terraform state is an opaque blob. We read these two fields for display only
// and tolerate their absence rather than validating the document's shape.
function peek(body: Buffer): { serial: number | null; lineage: string | null } {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { serial: null, lineage: null }
    const record: Record<string, unknown> = { ...parsed }
    return {
      serial: typeof record.serial === 'number' ? record.serial : null,
      lineage: typeof record.lineage === 'string' ? record.lineage : null
    }
  } catch {
    return { serial: null, lineage: null }
  }
}

export async function readCurrentState(projectId: string): Promise<Buffer | null> {
  const rows = await db()
    .select({ blobKey: stateVersion.blobKey })
    .from(projectState)
    .innerJoin(stateVersion, eq(projectState.currentVersionId, stateVersion.id))
    .where(eq(projectState.projectId, projectId))
  const key = rows[0]?.blobKey
  if (!key) return null
  const sealed = await store().get(key)
  if (!sealed) return null
  return open(env().ENCRYPTION_KEY, sealed)
}

export async function readVersion(versionId: string): Promise<Buffer | null> {
  const rows = await db()
    .select({ blobKey: stateVersion.blobKey })
    .from(stateVersion)
    .where(eq(stateVersion.id, versionId))
  const key = rows[0]?.blobKey
  if (!key) return null
  const sealed = await store().get(key)
  return sealed ? open(env().ENCRYPTION_KEY, sealed) : null
}

export async function writeState(args: {
  projectId: string
  orgSlug: string
  projectSlug: string
  body: Buffer
  userId: string
}): Promise<{ versionId: string }> {
  const versionId = ulid()
  const key = blobKey(args.orgSlug, args.projectSlug, versionId)
  const { serial, lineage } = peek(args.body)

  // Ordering is load-bearing: blob first, row second, pointer last. A failure
  // after the blob write leaves an unreferenced object, which the retention
  // sweep collects. The reverse order would leave a pointer to nothing.
  await store().put(key, seal(env().ENCRYPTION_KEY, args.body))

  await db().insert(stateVersion).values({
    id: versionId,
    projectId: args.projectId,
    serial,
    lineage,
    sizeBytes: args.body.length,
    md5: createHash('md5').update(args.body).digest('hex'),
    blobKey: key,
    createdBy: args.userId
  })

  await db()
    .insert(projectState)
    .values({ projectId: args.projectId, currentVersionId: versionId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: projectState.projectId,
      set: { currentVersionId: versionId, updatedAt: new Date() }
    })

  return { versionId }
}

export async function purgeState(projectId: string): Promise<void> {
  await db().delete(projectState).where(eq(projectState.projectId, projectId))
}

export async function listVersions(projectId: string, limit = 100): Promise<StateVersionRow[]> {
  return db()
    .select()
    .from(stateVersion)
    .where(eq(stateVersion.projectId, projectId))
    .orderBy(desc(stateVersion.createdAt))
    .limit(limit)
}

/**
 * Why a class and not a message: the endpoint has to map a lock conflict to 409
 * and a missing version to 404, and it used to do that by regex-matching the
 * message text. Rewording a throw would then have silently turned a 409 into a
 * 404. The reason is now part of the type.
 */
export type RollbackFailureReason = 'locked' | 'version-not-found'

export class RollbackError extends Error {
  readonly reason: RollbackFailureReason

  constructor(reason: RollbackFailureReason, message: string) {
    super(message)
    this.name = 'RollbackError'
    this.reason = reason
  }
}

export async function rollbackTo(args: {
  projectId: string
  orgSlug: string
  projectSlug: string
  versionId: string
  userId: string
}): Promise<{ versionId: string }> {
  // Rolling back under an active lock would race a running apply.
  const held = await currentLock(args.projectId)
  if (held) {
    throw new RollbackError(
      'locked',
      `State is locked by ${held.Who ?? 'another process'}; release it first`
    )
  }

  const body = await readVersion(args.versionId)
  if (!body) {
    throw new RollbackError('version-not-found', `Version not found: ${args.versionId}`)
  }

  // A new version carrying old bytes. History is append-only (spec §10), so a
  // rollback is itself a recorded event rather than an erasure of one.
  return writeState({
    projectId: args.projectId,
    orgSlug: args.orgSlug,
    projectSlug: args.projectSlug,
    body,
    userId: args.userId
  })
}
