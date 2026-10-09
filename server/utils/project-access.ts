import type { H3Event } from 'h3'
import { and, eq } from 'drizzle-orm'
import { createAccessControl } from 'better-auth/plugins/access'
import { db } from '../db/client'
import {
  environment,
  organization,
  project,
  projectAccess,
  projectMember,
  stateVersion,
  user
} from '../db/schema'
import { projectRoleSchema, type ProjectRole } from '../../shared/schemas/project-role'
import type { EffectiveRole, ProjectPermission } from '../../shared/project-permissions'
import { isAdmin, roleOf, type UserRole } from '../../shared/schemas/user'
import { requireSession, type Principal } from './ui-auth'
import type { TokenScope } from '../../shared/schemas/token'

/**
 * What a project role may do, in the organization plugin's vocabulary.
 * Spec §3 is the table; this is its only encoding. No route compares role
 * strings — they ask `projectCan`, which asks these objects.
 */
export const projectStatements = {
  project: ['read', 'rollback', 'unlock'],
  environment: ['create', 'delete', 'link', 'sync'],
  variable: ['write'],
  member: ['manage'],
  token: ['create']
} as const

export const projectAc = createAccessControl(projectStatements)

export const projectRoles = {
  viewer: projectAc.newRole({ project: ['read'] }),
  editor: projectAc.newRole({
    project: ['read', 'unlock'],
    environment: ['sync'],
    variable: ['write']
  }),
  owner: projectAc.newRole({
    project: ['read', 'rollback', 'unlock'],
    environment: ['create', 'delete', 'link', 'sync'],
    variable: ['write'],
    member: ['manage'],
    token: ['create']
  })
}

export type { ProjectPermission, EffectiveRole }

/** Each permission as the request the plugin's role objects understand. */
const REQUESTS = {
  'project:read': { project: ['read'] },
  'project:rollback': { project: ['rollback'] },
  'project:unlock': { project: ['unlock'] },
  'environment:create': { environment: ['create'] },
  'environment:delete': { environment: ['delete'] },
  'environment:link': { environment: ['link'] },
  'environment:sync': { environment: ['sync'] },
  'variable:write': { variable: ['write'] },
  'member:manage': { member: ['manage'] },
  'token:create': { token: ['create'] }
} as const satisfies Record<ProjectPermission, object>

export function projectCan(role: EffectiveRole, permission: ProjectPermission): boolean {
  if (role === 'admin') return true
  return projectRoles[role].authorize(REQUESTS[permission]).success
}

const ASCENDING: ProjectRole[] = ['viewer', 'editor', 'owner']

/** The lowest project role that may do this. Used for the 403 message only. */
export function minimumRoleFor(permission: ProjectPermission): ProjectRole {
  return ASCENDING.find((role) => projectCan(role, permission)) ?? 'owner'
}

/** The 404 a non-member and an unknown id share, byte for byte (spec §6, D2). */
export const NOT_FOUND = 'Unknown project. Check the project id and try again.'

function notFound(): never {
  throw createError({ statusCode: 404, statusMessage: NOT_FOUND })
}

/**
 * The one question every project-scoped check asks. A deployment admin is
 * `admin` on every project, membership row or not. An unrecognised role string
 * in the column resolves to no access: least privilege, as roleOf does.
 */
export async function effectiveRole(
  actor: { userId: string; role: UserRole },
  projectId: string
): Promise<EffectiveRole | null> {
  if (isAdmin(actor.role)) return 'admin'
  const rows = await db()
    .select({ role: projectMember.role })
    .from(projectMember)
    .where(and(eq(projectMember.organizationId, projectId), eq(projectMember.userId, actor.userId)))
  const parsed = projectRoleSchema.safeParse(rows[0]?.role)
  return parsed.success ? parsed.data : null
}

/** True when the account owns at least one project. Gates the tokens page and repository listing. */
export async function ownsAnyProject(userId: string): Promise<boolean> {
  const rows = await db()
    .select({ id: projectMember.id })
    .from(projectMember)
    .where(and(eq(projectMember.userId, userId), eq(projectMember.role, 'owner')))
    .limit(1)
  return rows.length > 0
}

/** effectiveRole for a caller known only by id, such as a token's creator. */
export async function effectiveRoleOfUser(
  userId: string,
  projectId: string
): Promise<EffectiveRole | null> {
  const rows = await db().select({ role: user.role }).from(user).where(eq(user.id, userId))
  const found = rows[0]
  if (!found) return null
  return effectiveRole({ userId, role: roleOf(found.role) }, projectId)
}

/**
 * The guard for every project-scoped /api/ui route. 401 without a session,
 * then 404 for no role (identical to an unknown project), then 403 naming
 * the role needed.
 *
 * A guard pass always means the project exists. A member's access row is
 * proof enough (membership FK). An admin is `admin` on any id, so the
 * `project` table is checked for them; `project`, not `project_access`, so an
 * admin still passes for a real project whose access row is missing (spec §4).
 */
export async function requireProjectPermission(
  event: H3Event,
  projectId: string,
  permission: ProjectPermission
): Promise<Principal & { projectRole: EffectiveRole }> {
  const principal = await requireSession(event)
  const role = await effectiveRole(principal, projectId)
  if (role === null) notFound()
  if (role === 'admin') {
    const real = await db()
      .select({ id: project.id })
      .from(project)
      .where(eq(project.id, projectId))
    if (real.length === 0) notFound()
  }
  if (!projectCan(role, permission)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Needs ${minimumRoleFor(permission)} access to this project. Ask a project owner.`
    })
  }
  return { ...principal, projectRole: role }
}

export async function projectIdOfEnvironment(environmentId: string): Promise<string> {
  const rows = await db()
    .select({ projectId: environment.projectId })
    .from(environment)
    .where(eq(environment.id, environmentId))
  return rows[0]?.projectId ?? notFound()
}

export async function projectIdOfVersion(versionId: string): Promise<string> {
  const rows = await db()
    .select({ projectId: stateVersion.projectId })
    .from(stateVersion)
    .where(eq(stateVersion.id, versionId))
  return rows[0]?.projectId ?? notFound()
}

/**
 * Creates the access row for a project that lacks one (spec §4: a crash
 * between the two inserts). Idempotent.
 */
export async function ensureAccessRecord(projectId: string, name: string): Promise<void> {
  await db()
    .insert(projectAccess)
    .values({ id: projectId, name, slug: projectId })
    .onConflictDoNothing({ target: projectAccess.id })
}

/**
 * Gate for the token pages: admins and anyone who owns a project. Returns the
 * session so callers need not read it twice.
 */
export async function requireTokenPage(event: H3Event): Promise<Principal> {
  const session = await requireSession(event)
  if (!isAdmin(session.role) && !(await ownsAnyProject(session.userId))) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Tokens are for admins and project owners. Ask a project owner.'
    })
  }
  return session
}

/**
 * Token creation (spec §7): `all` is admin-only; a project list needs owner on
 * every listed project. Resolves `org/project` refs to ids; an unknown ref is
 * the same 403 as an unowned one, so token creation cannot probe for slugs.
 * Any scope kind other than a project list is refused for a non-admin.
 */
export async function requireTokenAuthority(
  principal: Principal,
  scope: TokenScope
): Promise<void> {
  if (isAdmin(principal.role)) return
  const refuse = (): never => {
    throw createError({
      statusCode: 403,
      statusMessage: 'You can only create tokens for projects you own.'
    })
  }
  if (scope.kind !== 'projects') return refuse()
  for (const ref of scope.projects) {
    const [org, slug] = ref.split('/')
    const rows = await db()
      .select({ id: project.id })
      .from(project)
      .innerJoin(organization, eq(project.orgId, organization.id))
      .where(and(eq(organization.slug, org ?? ''), eq(project.slug, slug ?? '')))
    const id = rows[0]?.id
    if (!id || (await effectiveRole(principal, id)) !== 'owner') refuse()
  }
}
