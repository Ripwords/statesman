import { decodeTime, isValid } from 'ulid'
import { eq, inArray, desc } from 'drizzle-orm'
import { db } from '../db/client'
import { stateVersion, projectState, project, organization } from '../db/schema'
import { store } from '../storage'
import { env } from '../utils/env'
import { mapWithConcurrency } from '../utils/concurrency'

/**
 * Spec §10: keep the last N versions AND everything from the last D days,
 * whichever is greater — so a version is pruned only when it is BOTH beyond
 * the count and older than the window. The current version is never pruned.
 */
export async function runRetention(
  projectId: string
): Promise<{ prunedVersions: number; sweptBlobs: number }> {
  const config = env()

  const rows = await db()
    .select({ id: projectState.currentVersionId })
    .from(projectState)
    .where(eq(projectState.projectId, projectId))
  const currentId = rows[0]?.id ?? null

  const all = await db()
    .select()
    .from(stateVersion)
    .where(eq(stateVersion.projectId, projectId))
    .orderBy(desc(stateVersion.createdAt))

  const cutoff = new Date(Date.now() - config.RETENTION_KEEP_DAYS * 86_400_000)
  const doomed = all.filter(
    (v, index) =>
      v.id !== currentId && index >= config.RETENTION_KEEP_VERSIONS && v.createdAt < cutoff
  )

  if (doomed.length > 0) {
    // Row first, blob second — the same reasoning as the write path. A crash
    // between the two leaves an orphan the sweep below collects, rather than a
    // version row pointing at bytes that are gone.
    await db()
      .delete(stateVersion)
      .where(
        inArray(
          stateVersion.id,
          doomed.map((v) => v.id)
        )
      )
    for (const v of doomed) await store().delete(v.blobKey)
  }

  const sweptBlobs = await sweepOrphans(projectId)
  return { prunedVersions: doomed.length, sweptBlobs }
}

/**
 * How long a blob is left alone before it can be called an orphan.
 *
 * The sweep lists blobs and then reads the rows that claim them, while
 * writeState puts the blob BEFORE inserting its row — deliberately, so a crash
 * leaves an unreferenced object rather than a pointer to nothing (spec §9). In
 * between, a live write looks exactly like an orphan. Deleting it produces the
 * failure that ordering exists to prevent: the pointer names a blob that is
 * gone, GET answers 404, and Terraform plans a full recreate of everything.
 *
 * An hour is far longer than any single write and far shorter than the
 * retention window, so it costs nothing but the delay before wasted bytes are
 * reclaimed.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000

/**
 * When the blob key says it was written, from the ULID it is named after.
 *
 * Null for a key this code did not mint — those cannot be an in-flight write,
 * so they are swept on sight.
 */
function mintedAt(key: string): number | null {
  const name = key.split('/').at(-1)?.split('.')[0]
  if (!name || !isValid(name)) return null
  return decodeTime(name)
}

async function sweepOrphans(projectId: string): Promise<number> {
  const meta = await db()
    .select({ orgSlug: organization.slug, projectSlug: project.slug })
    .from(project)
    .innerJoin(organization, eq(project.orgId, organization.id))
    .where(eq(project.id, projectId))
  const location = meta[0]
  if (!location) return 0

  const prefix = `${location.orgSlug}/${location.projectSlug}/`
  const onDisk = await store().list(prefix)
  const known = new Set(
    (
      await db()
        .select({ blobKey: stateVersion.blobKey })
        .from(stateVersion)
        .where(eq(stateVersion.projectId, projectId))
    ).map((r) => r.blobKey)
  )

  const tooYoung = Date.now() - ORPHAN_GRACE_MS
  let swept = 0
  for (const key of onDisk) {
    if (known.has(key)) continue
    const written = mintedAt(key)
    // Read the rows AFTER listing and dating, so a row inserted during this
    // pass is still respected on the next one.
    if (written !== null && written > tooYoung) continue
    await store().delete(key)
    swept++
  }
  return swept
}

/**
 * Each sweep lists a whole storage prefix and issues its own deletes, so the
 * fan-out width is the project count — data, not a constant. Four at a time
 * keeps a pass parallel without letting the blob store or the Postgres pool see
 * hundreds of simultaneous callers.
 */
const RETENTION_CONCURRENCY = 4

export type RetentionSummary = { prunedVersions: number; sweptBlobs: number }

/** One retention pass over every project. Shared by the admin route and the
 * scheduled task so the two cannot drift. */
export async function runRetentionForAllProjects(): Promise<RetentionSummary> {
  const projects = await db().select({ id: project.id }).from(project)
  const results = await mapWithConcurrency(projects, RETENTION_CONCURRENCY, (p) =>
    runRetention(p.id)
  )
  return {
    prunedVersions: results.reduce((sum, r) => sum + r.prunedVersions, 0),
    sweptBlobs: results.reduce((sum, r) => sum + r.sweptBlobs, 0)
  }
}
