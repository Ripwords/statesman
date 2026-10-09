/**
 * Better Auth endpoints that answer over HTTP but must not be reachable from a
 * browser, because statesman has its own door for each:
 *
 * - `/organization/*`: the plugin checks authority against plugin membership
 *   alone, which refuses a deployment admin who is not a member and lets an
 *   owner act outside statesman's audit. Member management goes through
 *   /api/ui/projects/:id/members (project-access spec §6).
 * - `/api-key/create` and `/api-key/update`: these skip `requireTokenAuthority`
 *   (spec §7), so any signed-in account could mint or re-scope a token.
 *   Tokens are created through /api/ui/tokens, which calls
 *   `auth.api.createApiKey` server-side. `list`, `get` and `delete` stay open;
 *   the plugin scopes them to the caller's own keys.
 *
 * Paths are relative to the auth base path, in better-call's own terms.
 */
export const BLOCKED_AUTH_PREFIXES = ['/organization'] as const
export const BLOCKED_AUTH_PATHS = ['/api-key/create', '/api-key/update'] as const

const BASE_PATH = '/api/auth'
const DECODE_ROUNDS = 4

/**
 * Whether a request to the auth catch-all must be refused.
 *
 * better-call routes on `new URL(request.url).pathname`, which resolves `/./`,
 * `/%2e/`, `/x/../` and backslash variants. Testing the raw path the client
 * sent is therefore not enough: `/api/auth/%2e/organization/leave` does not
 * start with `/api/auth/organization/` and still reaches the plugin.
 *
 * So the path is put through the same URL parser, then percent-decoded and
 * re-parsed until it stops changing, and compared case-insensitively. This
 * refuses more spellings than the router would ever match, never fewer. A path
 * that cannot be decoded is refused rather than guessed at.
 */
export function isBlockedAuthPath(url: string): boolean {
  // Every spelling along the way is checked, not only the last: the first is
  // exactly what better-call routes on. Decoded paths go through the pathname
  // setter, not the URL constructor, so a decoded `//`, `?` or `#` cannot turn
  // into a host, query or fragment and drop the rest of the path.
  const candidates: string[] = []
  try {
    const parsed = new URL(url)
    let path = parsed.pathname
    candidates.push(path)
    for (let round = 0; round < DECODE_ROUNDS; round++) {
      parsed.pathname = decodeURIComponent(path)
      const next = parsed.pathname
      if (next === path) break
      candidates.push(next)
      path = next
    }
  } catch {
    return true
  }
  return candidates.some(matchesBlocked)
}

function matchesBlocked(pathname: string): boolean {
  const path = pathname
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
  if (!path.startsWith(`${BASE_PATH}/`)) return false
  const relative = path.slice(BASE_PATH.length)
  return (
    BLOCKED_AUTH_PREFIXES.some((p) => relative === p || relative.startsWith(`${p}/`)) ||
    (BLOCKED_AUTH_PATHS as readonly string[]).includes(relative)
  )
}
