import { eq, inArray, desc } from 'drizzle-orm'
import { db } from '../db/client'
import { stateVersion, projectState, project, organization } from '../db/schema'
import { store } from '../storage'
import { env } from '../utils/env'

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
      v.id !== currentId &&
      index >= config.RETENTION_KEEP_VERSIONS &&
      v.createdAt < cutoff
  )

  if (doomed.length > 0) {
    // Row first, blob second — the same reasoning as the write path. A crash
    // between the two leaves an orphan the sweep below collects, rather than a
    // version row pointing at bytes that are gone.
    await db().delete(stateVersion).where(inArray(stateVersion.id, doomed.map((v) => v.id)))
    for (const v of doomed) await store().delete(v.blobKey)
  }

  const sweptBlobs = await sweepOrphans(projectId)
  return { prunedVersions: doomed.length, sweptBlobs }
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

  let swept = 0
  for (const key of onDisk) {
    if (!known.has(key)) {
      await store().delete(key)
      swept++
    }
  }
  return swept
}
