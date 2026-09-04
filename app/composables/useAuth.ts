import { createAuthClient } from 'better-auth/vue'
import { z } from 'zod'

/**
 * Only the fields the dashboard renders. Everything else Better Auth returns is
 * dropped on purpose — see `toSessionState`.
 */
const sessionUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullish()
})
export type SessionUser = z.infer<typeof sessionUserSchema>

const sessionResponseSchema = z.object({ user: sessionUserSchema })

/**
 * Three outcomes, not two. Folding "the auth server did not answer" into
 * "anonymous" would sign a user out on a transient 500 and hide the outage
 * behind a login form.
 */
export type SessionState =
  | { status: 'authenticated', user: SessionUser }
  | { status: 'anonymous' }
  | { status: 'unavailable' }

type AuthClient = ReturnType<typeof createAuthClient>

let client: AuthClient | undefined

/**
 * Built on first use rather than at module scope: the client resolves its base
 * URL from `window.location`, which does not exist while Nuxt renders on the
 * server. Only sign-in and sign-out go through it — reading the session is
 * Nuxt's job (see `loadSession`), and tokens go through `/api/ui/tokens`.
 *
 * The brief imports `apiKeyClient` from `better-auth/client/plugins`. That
 * export does not exist in 1.7.2 (the plugin moved to `@better-auth/api-key`,
 * CARRY-FORWARD §1) and nothing in this dashboard calls `authClient.apiKey.*`,
 * so the plugin is left off entirely.
 */
export function useAuthClient(): AuthClient {
  client ??= createAuthClient()
  return client
}

/**
 * Narrows `GET /api/auth/get-session` to the one field the UI needs.
 *
 * This is a security boundary, not a convenience. Better Auth answers with
 * `{ session, user }`, and `session` carries the live session token along with
 * its id, the caller's IP address and user agent. Anything placed in `useState`
 * is serialized into `<script id="__NUXT_DATA__">` in the SSR HTML, so storing
 * the response as-received would publish an HttpOnly credential in the page
 * source. Zod's object parse strips every key not named here, which is what
 * keeps that from happening by construction rather than by remembering to.
 *
 * Exported so the guarantee can be tested without a browser.
 */
export function toSessionState(response: unknown): SessionState {
  const parsed = sessionResponseSchema.safeParse(response)
  return parsed.success
    ? { status: 'authenticated', user: parsed.data.user }
    : { status: 'anonymous' }
}

/** `undefined` means "not looked up yet". */
function sessionState() {
  return useState<SessionState | undefined>('statesman:session', () => undefined)
}

/**
 * Resolves the session through Nuxt's data layer instead of Better Auth's
 * browser store. `useRequestFetch` forwards the incoming cookie header during
 * SSR — the store cannot, because it reads the cookie from the document — and
 * `useState` carries the answer into the client payload, so the session costs
 * one round trip per page load rather than one per component.
 */
export async function loadSession(options: { force?: boolean } = {}): Promise<SessionState> {
  const state = sessionState()
  if (!options.force && state.value !== undefined) return state.value
  const request = useRequestFetch()

  let response: unknown
  try {
    response = await request('/api/auth/get-session')
  } catch {
    // A throw here is transport or a non-2xx: the server could not tell us who
    // this is. That is not the same as "nobody".
    state.value = { status: 'unavailable' }
    return state.value
  }

  state.value = toSessionState(response)
  return state.value
}

/**
 * Why every call below is wrapped: Better Auth's client returns `{ data, error }`
 * for an HTTP error but *throws* when the request never completes — a dropped
 * connection surfaces as `TypeError: Failed to fetch` out of `betterFetch`,
 * verified against the real client. Reading only `error` therefore leaves the
 * caller's `pending` flag stuck on forever and the user with no explanation.
 */
export type SignInResult = { ok: true } | { ok: false, reason: 'rejected' | 'unreachable' }

export function useAuth() {
  const state = sessionState()
  const user = computed<SessionUser | null>(() =>
    state.value?.status === 'authenticated' ? state.value.user : null
  )

  async function signIn(credentials: { email: string, password: string }): Promise<SignInResult> {
    try {
      const { error } = await useAuthClient().signIn.email(credentials)
      if (error) return { ok: false, reason: 'rejected' }
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    await loadSession({ force: true })
    return { ok: true }
  }

  /**
   * The local session is given up only once the server confirms it dropped the
   * cookie. Clearing state on a failed call would paint a signed-out UI over a
   * session that is still live, and the next reload would sign the user
   * straight back in.
   */
  async function signOut(): Promise<{ ok: boolean }> {
    try {
      const { error } = await useAuthClient().signOut()
      if (error) return { ok: false }
    } catch {
      return { ok: false }
    }
    state.value = { status: 'anonymous' }
    await navigateTo('/login')
    return { ok: true }
  }

  return { user, signIn, signOut }
}
