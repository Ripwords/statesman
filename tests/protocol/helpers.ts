import { eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../../server/db/client'
import {
  organization,
  project,
  stateVersion,
  projectState,
  stateLock,
  auditLog,
  user
} from '../../server/db/schema'
import { store } from '../../server/storage'

/**
 * Vitest runs test FILES in parallel against one database and one blob root,
 * and vitest.config.ts is a frozen Phase 0 file, so the suites cannot be
 * serialised from here. They are separated instead: every protocol suite owns
 * its own organization slug, which also gives it its own `<org>/` blob prefix.
 * Nothing is shared, so nothing has to be locked.
 */
export async function resetDb(orgSlug: string): Promise<void> {
  const orgs = await db()
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, orgSlug))
  const orgIds = orgs.map((o) => o.id)

  if (orgIds.length > 0) {
    const projects = await db()
      .select({ id: project.id })
      .from(project)
      .where(inArray(project.orgId, orgIds))
    const projectIds = projects.map((p) => p.id)

    // project_state.current_version_id is ON DELETE RESTRICT, so the pointer
    // has to go before the versions it points at.
    if (projectIds.length > 0) {
      await db().delete(stateLock).where(inArray(stateLock.projectId, projectIds))
      await db().delete(projectState).where(inArray(projectState.projectId, projectIds))
      await db().delete(stateVersion).where(inArray(stateVersion.projectId, projectIds))
    }
    await db().delete(auditLog).where(inArray(auditLog.orgId, orgIds))
    await db().delete(project).where(inArray(project.orgId, orgIds))
    await db().delete(organization).where(inArray(organization.id, orgIds))
  }

  // Blob keys are `<org>/<project>/<versionId>.tfstate.enc`, so this clears
  // exactly the objects belonging to this suite — including the ones the
  // orphan sweep is supposed to find.
  for (const key of await store().list(`${orgSlug}/`)) {
    await store().delete(key)
  }
}

/**
 * organization.slug is unique, so seeding twice under an org that already exists
 * has to reuse it rather than insert a duplicate.
 *
 * Separate from seedProject because the two are different things: an
 * organization is provisioned once per deployment (spec §5), while a project is
 * created through `POST /api/ui/projects`. A test that wants to exercise that
 * endpoint still needs the organization to exist first.
 */
export async function seedOrg(orgSlug: string): Promise<string> {
  const existing = await db()
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, orgSlug))
  const found = existing[0]
  if (found) return found.id

  const orgId = ulid()
  await db().insert(organization).values({ id: orgId, name: orgSlug, slug: orgSlug })
  return orgId
}

export async function seedProject(orgSlug: string, projectSlug: string): Promise<string> {
  const orgId = await seedOrg(orgSlug)
  const projectId = ulid()
  await db().insert(project).values({
    id: projectId,
    orgId,
    name: projectSlug,
    slug: projectSlug
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
