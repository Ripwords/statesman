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
import { auth } from '../../server/utils/auth'
import { provisioning, provisioningConfig } from '../../scripts/provision'
import type { UserRole } from '../../shared/schemas/user'

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

/**
 * Creates a sign-in-able account the way an operator does.
 *
 * `auth.api.signUpEmail` is not an option any more: the server sets
 * `disableSignUp`, and it refuses server-side calls too — verified, not assumed.
 * Going through the same module `pnpm user:create` uses means these suites
 * exercise the real provisioning path rather than a door only tests can open.
 */
export async function provisionUser(
  email: string,
  password: string,
  role?: UserRole
): Promise<{ id: string; email: string }> {
  const admin = provisioning(provisioningConfig())
  try {
    // Explicit rather than defaulted to admin. A suite that drives an
    // admin-only route has to say so, or a guard regression would show up as
    // every test still passing.
    return await admin.createUser({ email, password, name: 'Test', role })
  } finally {
    await admin.close()
  }
}

/**
 * Signs in and returns headers carrying the session cookie, so a test can drive
 * a route handler as a real signed-in person rather than as a mocked session.
 *
 * `asResponse` is what makes the Set-Cookie header reachable — the plain call
 * returns the session body and drops the cookie the guards actually read.
 */
export async function signInHeaders(email: string, password: string): Promise<Headers> {
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true
  })
  const cookie = response.headers.get('set-cookie')
  if (cookie === null) {
    throw new Error(`sign-in for ${email} returned no session cookie`)
  }
  // Set-Cookie carries attributes (Path, HttpOnly, SameSite…) that a Cookie
  // request header must not repeat; only the name=value pair before the first
  // semicolon belongs there. Multiple cookies arrive comma-separated.
  const pairs = cookie
    .split(/,(?=[^;]+?=)/)
    .map((part) => part.split(';')[0]?.trim())
    .filter((part): part is string => part !== undefined && part !== '')
  return new Headers({ cookie: pairs.join('; ') })
}

/** Sets a provisioned account's role directly, the way the migration backfill does. */
export async function setRole(userId: string, role: UserRole): Promise<void> {
  await db().update(user).set({ role }).where(eq(user.id, userId))
}
