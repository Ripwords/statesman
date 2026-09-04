import type { H3Event } from 'h3'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/client'
import { organization, project } from '../db/schema'
import { acquireLock, releaseLock } from '../services/lock'
import { recordAuditBestEffort } from '../services/audit'
import { lockInfoSchema, type LockInfo } from '../../shared/schemas/lock'
import { projectRefSchema, type ProjectRef } from '../../shared/schemas/project'
import type { TfPrincipal } from './tf-auth'

export type ResolvedProject = { id: string; orgId: string; ref: ProjectRef }

// Terraform appends the held lock id to the write address as ?ID=<lock-id>.
// Anything else on the query string is Terraform's business, not ours.
export const lockIdQuerySchema = z.object({ ID: z.string().optional() })

/** Methods h3 will read a request body for. Everything else hits assertMethod. */
const H3_PAYLOAD_METHODS = ['PATCH', 'POST', 'PUT', 'DELETE']

export async function refFromEvent(event: H3Event): Promise<ProjectRef> {
  try {
    return await getValidatedRouterParams(event, projectRefSchema.parse)
  } catch {
    // h3's validateData rewrites ANY validator throw into 400 Validation Error,
    // so the intended status cannot be thrown from inside the schema. A slug
    // that cannot name a project is an unknown project, and spec §11 says that
    // is 404 — replace the status out here, where it survives.
    throw createError({ statusCode: 404, statusMessage: 'Unknown project' })
  }
}

export async function resolveProject(ref: ProjectRef): Promise<ResolvedProject> {
  const rows = await db()
    .select({ id: project.id, orgId: project.orgId })
    .from(project)
    .innerJoin(organization, eq(project.orgId, organization.id))
    .where(and(eq(organization.slug, ref.org), eq(project.slug, ref.project)))
  const row = rows[0]
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Unknown project' })
  return { id: row.id, orgId: row.orgId, ref }
}

/**
 * h3 1.15.11 refuses to read a body on any method outside PATCH/POST/PUT/DELETE
 * (`readRawBody` calls `assertMethod` before touching the stream), and
 * Terraform's LOCK/UNLOCK verbs carry the lock info as their body. Spec §2
 * requires both verbs to work, so on those two we collect the request stream
 * ourselves and hand the bytes to the same schema h3 would have applied.
 * Validation stays bound to the read, which is the property CARRY-FORWARD §7c
 * exists to protect.
 */
export async function readLockInfo(event: H3Event): Promise<LockInfo> {
  if (H3_PAYLOAD_METHODS.includes(event.method)) {
    return readValidatedBody(event, lockInfoSchema.parse)
  }

  const stream: AsyncIterable<Buffer> = event.node.req
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Malformed lock info' })
  }
  const parsed = lockInfoSchema.safeParse(payload)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Malformed lock info' })
  }
  return parsed.data
}

/**
 * Both lock paths funnel through here so the 423 response body cannot drift
 * between them.
 *
 * The holder's LockInfo is the response body ITSELF, not `data` inside an h3
 * error envelope: Terraform json.Unmarshals the raw body straight into
 * statemgr.LockInfo, so an envelope would deserialise to an empty struct and
 * the CLI would report the lock as held by nobody (spec §11).
 */
export async function handleLockAcquire(
  event: H3Event,
  resolved: ResolvedProject,
  principal: TfPrincipal
): Promise<{ ok: true } | LockInfo> {
  const info = await readLockInfo(event)
  const result = await acquireLock(resolved.id, info)
  if (!result.ok) {
    setResponseStatus(event, 423)
    return result.held
  }
  // The lock row is already committed. A 500 here would tell Terraform the
  // lock was refused while it is in fact held, stranding the project behind a
  // force-unlock.
  await recordAuditBestEffort({
    orgId: resolved.orgId,
    projectId: resolved.id,
    actorType: 'api-key',
    actorId: principal.keyId,
    action: 'lock.acquire',
    meta: { lockId: info.ID, who: info.Who }
  })
  return { ok: true }
}

export async function handleLockRelease(
  event: H3Event,
  resolved: ResolvedProject,
  principal: TfPrincipal
): Promise<{ ok: true }> {
  const info = await readLockInfo(event)
  const released = await releaseLock(resolved.id, info.ID)
  await recordAuditBestEffort({
    orgId: resolved.orgId,
    projectId: resolved.id,
    actorType: 'api-key',
    actorId: principal.keyId,
    action: released ? 'lock.release' : 'lock.release_mismatch',
    meta: { lockId: info.ID }
  })
  return { ok: true }
}
