import { createAuthClient } from 'better-auth/vue'

export type SessionUser = {
  id: string
  name: string
  email: string
  image?: string | null
}

export type SessionPayload = { user: SessionUser } | null

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

/** `undefined` means "not looked up yet"; `null` means "looked up, anonymous". */
function sessionState() {
  return useState<SessionPayload | undefined>('statesman:session', () => undefined)
}

/**
 * Resolves the session through Nuxt's data layer instead of Better Auth's
 * browser store. `useRequestFetch` forwards the incoming cookie header during
 * SSR — the store cannot, because it reads the cookie from the document — and
 * `useState` carries the answer into the client payload, so the session costs
 * one round trip per page load rather than one per component.
 */
export async function loadSession(options: { force?: boolean } = {}): Promise<SessionPayload> {
  const state = sessionState()
  if (!options.force && state.value !== undefined) return state.value
  const request = useRequestFetch()
  state.value = await request<SessionPayload>('/api/auth/get-session').catch(() => null)
  return state.value
}

export function useAuth() {
  const state = sessionState()
  const user = computed<SessionUser | null>(() => state.value?.user ?? null)

  async function signIn(credentials: { email: string, password: string }) {
    const { error } = await useAuthClient().signIn.email(credentials)
    if (!error) await loadSession({ force: true })
    return { error }
  }

  async function signOut() {
    await useAuthClient().signOut()
    state.value = null
    await navigateTo('/login')
  }

  return { user, signIn, signOut }
}
