import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { project, projectAccess } from '../db/schema'
import { recordAuditBestEffort } from './audit'
import type { UpdateProjectInput } from '../../shared/schemas/project'

/**
 * Applies a settings change (project-settings spec §4). The slug is never
 * written. A rename is copied to the access row so the plugin's name does not
 * drift. The audit row names the fields, not their values.
 */
export async function updateProject(input: {
  projectId: string
  actorId: string
  changes: UpdateProjectInput
}): Promise<void> {
  const fields = Object.keys(input.changes).toSorted()
  if (fields.length === 0) return
  // Two statements, not a transaction: Neon HTTP has none. A crash between
  // them leaves the access row on the old name; saving again repairs it.
  const [updated] = await db()
    .update(project)
    .set(input.changes)
    .where(eq(project.id, input.projectId))
    .returning({ orgId: project.orgId })
  if (input.changes.name !== undefined) {
    await db()
      .update(projectAccess)
      .set({ name: input.changes.name })
      .where(eq(projectAccess.id, input.projectId))
  }
  const orgId = updated?.orgId
  if (orgId === undefined) return
  await recordAuditBestEffort({
    orgId,
    projectId: input.projectId,
    actorType: 'user',
    actorId: input.actorId,
    action: 'project.update',
    meta: { fields }
  })
}
