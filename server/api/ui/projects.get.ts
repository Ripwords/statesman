import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import {
  organization,
  project,
  projectMember,
  projectState,
  stateLock,
  stateVersion
} from '../../db/schema'
import { projectRoleSchema } from '../../../shared/schemas/project-role'
import { isAdmin } from '../../../shared/schemas/user'
import type { EffectiveRole } from '../../utils/project-access'
import { requireSession } from '../../utils/ui-auth'
import { env } from '../../utils/env'
import { effectiveRetention } from '../../../shared/retention'

/**
 * One row per project with everything the list and the project page need.
 * `projectState` and `stateVersion` are left-joined because a project exists
 * from its first lock attempt, before any state has been written.
 *
 * Filtered by membership: a deployment admin sees every project, anyone else
 * only those they hold a role on. `myRole` is the caller's role on each row.
 */
export default defineEventHandler(async (event) => {
  const principal = await requireSession(event)
  const admin = isAdmin(principal.role)
  const rows = await db()
    .select({
      id: project.id,
      slug: project.slug,
      name: project.name,
      description: project.description,
      archivedAt: project.archivedAt,
      retentionKeepVersions: project.retentionKeepVersions,
      retentionKeepDays: project.retentionKeepDays,
      memberRole: projectMember.role,
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
    .leftJoin(
      projectMember,
      and(eq(projectMember.organizationId, project.id), eq(projectMember.userId, principal.userId))
    )
    .where(admin ? undefined : isNotNull(projectMember.id))
    // NULLS LAST, so a project that exists but has never been written to sits
    // at the bottom rather than the top of the list.
    .orderBy(sql`${projectState.updatedAt} desc nulls last`)

  const config = env()
  const defaults = {
    keepVersions: config.RETENTION_KEEP_VERSIONS,
    keepDays: config.RETENTION_KEEP_DAYS
  }
  return rows.flatMap(
    ({ memberRole, archivedAt, retentionKeepVersions, retentionKeepDays, ...row }) => {
      // Admins are `admin` everywhere (spec §3). A member row with an
      // unrecognised role string resolves to no access, as effectiveRole does.
      const myRole: EffectiveRole | null = admin
        ? 'admin'
        : (projectRoleSchema.safeParse(memberRole).data ?? null)
      if (myRole === null) return []
      const retention = effectiveRetention(
        { keepVersions: retentionKeepVersions, keepDays: retentionKeepDays },
        defaults
      )
      return [{ ...row, archived: archivedAt !== null, retention, myRole }]
    }
  )
})
