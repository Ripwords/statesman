import { ulid } from 'ulid'
import { db } from '../../server/db/client'
import {
  organization, project, stateVersion, projectState, stateLock, auditLog
} from '../../server/db/schema'

export async function resetDb(): Promise<void> {
  await db().delete(stateLock)
  await db().delete(projectState)
  await db().delete(stateVersion)
  await db().delete(auditLog)
  await db().delete(project)
  await db().delete(organization)
}

export async function seedProject(orgSlug: string, projectSlug: string): Promise<string> {
  const orgId = ulid()
  const projectId = ulid()
  await db().insert(organization).values({ id: orgId, name: orgSlug, slug: orgSlug })
  await db().insert(project).values({
    id: projectId, orgId, name: projectSlug, slug: projectSlug
  })
  return projectId
}
