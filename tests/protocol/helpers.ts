import { ulid } from 'ulid'
import { db } from '../../server/db/client'
import {
  organization, project, stateVersion, projectState, stateLock, auditLog, user
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

/**
 * state_version.created_by carries an FK to user.id, so a test that writes
 * state has to own a real user row. resetDb deliberately leaves `user`
 * untouched (the endpoint suite's API key hangs off one), which makes this
 * insert idempotent rather than per-test.
 */
export async function seedUser(id: string): Promise<string> {
  await db()
    .insert(user)
    .values({ id, name: id, email: `${id}@statesman.test` })
    .onConflictDoNothing({ target: user.id })
  return id
}
