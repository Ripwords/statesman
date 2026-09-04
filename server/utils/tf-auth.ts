import type { H3Event } from 'h3'
import { auth } from './auth'
import {
  stateActionSchema,
  tokenScopeSchema,
  type StateAction,
  type TokenScope
} from '../../shared/schemas/token'
import type { ProjectRef } from '../../shared/schemas/project'

export type TfPrincipal = {
  userId: string
  keyId: string
  actions: StateAction[]
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
  if (scope.kind === 'all') return true
  return scope.projects.includes(`${org}/${project}`)
}

export async function authorizeTf(
  event: H3Event,
  ref: ProjectRef,
  action: StateAction
): Promise<TfPrincipal> {
  const key = parseBasicAuth(getRequestHeader(event, 'authorization'))
  if (!key) {
    setResponseHeader(event, 'WWW-Authenticate', 'Basic realm="statesman"')
    throw createError({ statusCode: 401, statusMessage: 'Missing or malformed credentials' })
  }

  const result = await auth.api.verifyApiKey({ body: { key, permissions: { state: [action] } } })
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

  if (!scopeAllows(scope, ref.org, ref.project)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Token is not scoped to ${ref.org}/${ref.project}`
    })
  }

  const parsedActions = stateActionSchema.array().safeParse(result.key.permissions?.state ?? [])
  const actions: StateAction[] = parsedActions.success ? parsedActions.data : []

  // `referenceId`, not `userId`: the plugin's owner column is generic over
  // user-or-organization. `result.key.userId` does not exist.
  return { userId: result.key.referenceId, keyId: result.key.id, actions, scope }
}
