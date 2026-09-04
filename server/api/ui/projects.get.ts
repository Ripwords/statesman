import { desc, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { organization, project, projectState, stateLock, stateVersion } from '../../db/schema'
import { requireSession } from '../../utils/ui-auth'

/**
 * One row per project with everything the list and the project page need.
 * `projectState` and `stateVersion` are left-joined because a project exists
 * from its first lock attempt, before any state has been written.
 */
export default defineEventHandler(async (event) => {
  await requireSession(event)
  return db()
    .select({
      id: project.id,
      slug: project.slug,
      name: project.name,
      org: organization.slug,
      updatedAt: projectState.updatedAt,
      serial: stateVersion.serial,
      sizeBytes: stateVersion.sizeBytes,
      lockedBy: stateLock.who,
      lockedAt: stateLock.createdAt,
      versionCount: sql<number>`(
        select count(*)::int from state_version sv where sv.project_id = ${project.id}
      )`
    })
    .from(project)
    .innerJoin(organization, eq(project.orgId, organization.id))
    .leftJoin(projectState, eq(projectState.projectId, project.id))
    .leftJoin(stateVersion, eq(projectState.currentVersionId, stateVersion.id))
    .leftJoin(stateLock, eq(stateLock.projectId, project.id))
    .orderBy(desc(projectState.updatedAt))
})
