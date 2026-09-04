import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../../db/client'
import { projectState, stateVersion, user } from '../../../../db/schema'
import { requireSession } from '../../../../utils/ui-auth'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  // 400 is the right status for a malformed id here, so h3's blanket rewrite of
  // a validator throw needs no catch — CARRY-FORWARD §7c.
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)

  const pointer = await db()
    .select({ currentVersionId: projectState.currentVersionId })
    .from(projectState)
    .where(eq(projectState.projectId, id))

  const versions = await db()
    .select({
      id: stateVersion.id,
      serial: stateVersion.serial,
      lineage: stateVersion.lineage,
      sizeBytes: stateVersion.sizeBytes,
      md5: stateVersion.md5,
      createdAt: stateVersion.createdAt,
      authorName: user.name,
      authorEmail: user.email
    })
    .from(stateVersion)
    .leftJoin(user, eq(stateVersion.createdBy, user.id))
    .where(eq(stateVersion.projectId, id))
    .orderBy(desc(stateVersion.createdAt))
    .limit(200)

  return { currentVersionId: pointer[0]?.currentVersionId ?? null, versions }
})
