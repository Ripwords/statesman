import type { H3Event } from 'h3'
import { and, eq } from 'drizzle-orm'
import { createAccessControl } from 'better-auth/plugins/access'
import { db } from '../db/client'
import { ensureAccessRecordIn } from '../db/access-record'
import { environment, organization, project, projectMember, stateVersion, user } from '../db/schema'
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
  project: ['read', 'update', 'rollback', 'unlock'],
  environment: ['create', 'delete', 'link', 'sync'],
  variable: ['write', 'download'],
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
    project: ['read', 'update', 'rollback', 'unlock'],
    environment: ['create', 'delete', 'link', 'sync'],
    variable: ['write', 'download'],
    member: ['manage'],
    token: ['create']
  })
}

export type { ProjectPermission, EffectiveRole }

/** Each permission as the request the plugin's role objects understand. */
const REQUESTS = {
  'project:read': { project: ['read'] },
  'project:update': { project: ['update'] },
  'project:rollback': { project: ['rollback'] },
  'project:unlock': { project: ['unlock'] },
  'environment:create': { environment: ['create'] },
  'environment:delete': { environment: ['delete'] },
  'environment:link': { environment: ['link'] },
  'environment:sync': { environment: ['sync'] },
  'variable:write': { variable: ['write'] },
  'variable:download': { variable: ['download'] },
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

/**
 * What still works on an archived project (project-settings spec §5): reading,
 * clearing a stuck lock, renaming, downloading variables and managing members.
 * Everything else is refused with ARCHIVED.
 */
export const ARCHIVED_ALLOWED: ReadonlySet<ProjectPermission> = new Set<ProjectPermission>([
  'project:read',
  'project:unlock',
  'project:update',
  'variable:download',
  'member:manage'
])

export const ARCHIVED = 'This project is archived. An admin can unarchive it.'

function archived(): never {
  throw createError({ statusCode: 409, statusMessage: ARCHIVED })
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
  const rows = await db()
    .select({ archivedAt: project.archivedAt })
    .from(project)
    .where(eq(project.id, projectId))
  const found = rows[0]
  if (!found) notFound()
  if (!projectCan(role, permission)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Needs ${minimumRoleFor(permission)} access to this project. Ask a project owner.`
    })
  }
  // After the role check, so a viewer is told about the role it lacks rather
  // than about a state an admin would have to change anyway.
  if (found.archivedAt !== null && !ARCHIVED_ALLOWED.has(permission)) archived()
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
  await ensureAccessRecordIn(db(), projectId, name)
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
  const admin = isAdmin(principal.role)
  const refuse = (): never => {
    throw createError({
      statusCode: 403,
      statusMessage: 'You can only create tokens for projects you own.'
    })
  }
  if (scope.kind !== 'projects') return admin ? undefined : refuse()
  for (const ref of scope.projects) {
    const [org, slug] = ref.split('/')
    const rows = await db()
      .select({ id: project.id, archivedAt: project.archivedAt })
      .from(project)
      .innerJoin(organization, eq(project.orgId, organization.id))
      .where(and(eq(organization.slug, org ?? ''), eq(project.slug, slug ?? '')))
    const found = rows[0]
    if (admin) {
      // An admin may name a project that does not exist yet; refusing that is
      // not this change's business. An archived one cannot be written, so a
      // token for it would only ever fail.
      if (found?.archivedAt) archived()
      continue
    }
    if (!found || (await effectiveRole(principal, found.id)) !== 'owner') refuse()
    if (found?.archivedAt) archived()
  }
}
