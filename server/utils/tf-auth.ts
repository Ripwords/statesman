import type { H3Event } from 'h3'
import { auth } from './auth'
import {
  stateActionSchema,
  tokenScopeSchema,
  varActionSchema,
  type StateAction,
  type TokenScope,
  type VarAction
} from '../../shared/schemas/token'
import type { ProjectRef } from '../../shared/schemas/project'
import type { ProjectRole } from '../../shared/schemas/project-role'
import { effectiveRoleOfUser, type EffectiveRole } from './project-access'
import type { ResolvedProject } from './tf-handler'

export type TfPrincipal = {
  userId: string
  keyId: string
  actions: StateAction[]
  varActions: VarAction[]
  scope: TokenScope
}

/**
 * Terraform sends the API key as the Basic Auth password. The username is
 * whatever the operator wrote in the backend block (we document `statesman`)
 * and carries no meaning, so it is discarded.
 *
 * Only the FIRST colon separates the pair: a key may legitimately contain
 * colons and splitting on every one would silently truncate it.
 */
export function parseBasicAuth(header: string | undefined): string | null {
  if (!header?.startsWith('Basic ')) return null
  let decoded: string
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  } catch {
    return null
  }
  const separator = decoded.indexOf(':')
  if (separator === -1) return null
  const password = decoded.slice(separator + 1)
  return password.length > 0 ? password : null
}

/**
 * Project scope is ours to enforce — Better Auth's `permissions` is
 * resource->actions, not resource->instances (spec §4). Exact string equality
 * on `org/project`, never a prefix test, so `acme/prod` cannot reach
 * `acme/prod-2`.
 */
export function scopeAllows(scope: TokenScope, org: string, project: string): boolean {
  // `all` means every project in the deployment, and says so. It is honoured
  // only while the creator is a deployment admin: requireCreatorAccess
  // enforces that on every request, so this line stays a pure scope check.
  if (scope.kind === 'all') return true
  return scope.projects.includes(`${org}/${project}`)
}

/**
 * Step 1 of spec §9: who is calling. Nothing about the request path is
 * consulted here, so an anonymous caller is turned away before any database
 * query runs and cannot use the response to learn whether a project exists.
 */
export async function authenticateTf(event: H3Event): Promise<TfPrincipal> {
  const key = parseBasicAuth(getRequestHeader(event, 'authorization'))
  if (!key) {
    setResponseHeader(event, 'WWW-Authenticate', 'Basic realm="statesman"')
    throw createError({ statusCode: 401, statusMessage: 'Missing or malformed credentials' })
  }

  // Deliberately no `permissions` argument. verifyApiKey folds a permission
  // miss into `valid: false`, so passing the action here reports an
  // AUTHORIZATION failure as 401 "Invalid API key" — which tells an operator to
  // rotate a key that was never invalid. 401 from this function means only:
  // unknown, expired, disabled, or rate-limited. The action check is spec §9
  // step 4 and lives in authorizeTf, where it can answer 403.
  const result = await auth.api.verifyApiKey({ body: { key } })
  if (!result.valid || !result.key) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid API key' })
  }

  // The plugin already deserialises metadata into an object; it is typed as
  // Record<string, any>, so widen it to unknown before reading anything out.
  const metadata: Record<string, unknown> | null = result.key.metadata
  const parsedScope = tokenScopeSchema.safeParse(metadata?.scope)
  // A key with no recorded scope grants nothing. Failing closed is the only
  // safe reading of missing authorization data.
  const scope: TokenScope = parsedScope.success
    ? parsedScope.data
    : { kind: 'projects', projects: [] }

  const parsedActions = stateActionSchema.array().safeParse(result.key.permissions?.state ?? [])
  const actions: StateAction[] = parsedActions.success ? parsedActions.data : []

  // Same fail-closed parse as `actions`. Every token issued before variables
  // existed has no `vars` entry and lands here as [] — it is not widened.
  const parsedVarActions = varActionSchema.array().safeParse(result.key.permissions?.vars ?? [])
  const varActions: VarAction[] = parsedVarActions.success ? parsedVarActions.data : []

  // `referenceId`, not `userId`: the plugin's owner column is generic over
  // user-or-organization. `result.key.userId` does not exist.
  return { userId: result.key.referenceId, keyId: result.key.id, actions, varActions, scope }
}

/**
 * Steps 3 and 4 of spec §9: may this caller do this to this project. Runs
 * AFTER the project has been resolved, so an unknown project is already a 404
 * and never reaches here.
 *
 * Both failures are 403 per spec §11 — the credential is good, the request is
 * not permitted.
 */
export function authorizeTf(principal: TfPrincipal, ref: ProjectRef, action: StateAction): void {
  if (!scopeAllows(principal.scope, ref.org, ref.project)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Token is not scoped to ${ref.org}/${ref.project}`
    })
  }
  if (!principal.actions.includes(action)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Token does not permit the "${action}" action`
    })
  }
}

/**
 * The variables door's step 3 and 4 (variables spec §5): the same project
 * scope as state, and a separate resource, so a token that can read state
 * cannot read secrets unless it was issued to.
 */
export function authorizeVars(principal: TfPrincipal, ref: ProjectRef): void {
  if (!scopeAllows(principal.scope, ref.org, ref.project)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Token is not scoped to ${ref.org}/${ref.project}`
    })
  }
  if (!principal.varActions.includes('read')) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Token does not permit reading variables'
    })
  }
}

export type CreatorNeed = 'state:read' | 'state:write' | 'vars:read'

/** R1: anything that changes state (write, lock, delete) needs editor. */
export function stateNeed(action: StateAction): CreatorNeed {
  return action === 'read' ? 'state:read' : 'state:write'
}

const FLOOR: Record<CreatorNeed, ProjectRole> = {
  'state:read': 'viewer',
  'state:write': 'editor',
  'vars:read': 'owner'
}
const RANK: Record<EffectiveRole, number> = { viewer: 0, editor: 1, owner: 2, admin: 3 }

/**
 * A token is its creator's authority, delegated (project-access spec §7). It
 * is re-checked on every request so that removing someone from a project
 * disarms their CI tokens without anyone having to find and revoke them.
 * Runs after authorizeTf / authorizeVars, which check the token's own scope
 * and actions. A deleted creator or an unrecognised role resolves to no
 * access, which is the same 403.
 */
export async function requireCreatorAccess(
  principal: TfPrincipal,
  resolved: ResolvedProject,
  need: CreatorNeed
): Promise<void> {
  const role = await effectiveRoleOfUser(principal.userId, resolved.id)
  const allowed =
    role !== null &&
    (principal.scope.kind === 'all' ? role === 'admin' : RANK[role] >= RANK[FLOOR[need]])
  if (!allowed) {
    throw createError({
      statusCode: 403,
      statusMessage: `The account that created this token no longer has access to ${resolved.ref.org}/${resolved.ref.project}`
    })
  }
}
