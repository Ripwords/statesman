import { describe, expect, it } from 'vitest'
import { toSessionState } from '../../app/composables/useAuth'

/**
 * Whatever `loadSession` stores goes into `useState`, and Nuxt serializes
 * `useState` into `<script id="__NUXT_DATA__">` in the SSR HTML. Better Auth's
 * `/api/auth/get-session` answers with the session row as well as the user, and
 * that row carries the live session token. These tests pin the narrowing that
 * keeps the credential out of the page source.
 */
const GET_SESSION_RESPONSE = {
  session: {
    id: 'sess_01ABC',
    token: 'THE-LIVE-SESSION-TOKEN',
    userId: 'u1',
    expiresAt: '2026-09-11T04:14:22.988Z',
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (Macintosh)',
    createdAt: '2026-09-04T04:14:22.988Z',
    updatedAt: '2026-09-04T04:14:22.988Z'
  },
  user: {
    id: 'u1',
    name: 'Dev User',
    email: 'dev@statesman.test',
    emailVerified: false,
    image: null,
    createdAt: '2026-09-04T04:14:22.916Z',
    updatedAt: '2026-09-04T04:14:22.916Z'
  }
}

describe('toSessionState', () => {
  it('never carries the session token into the state Nuxt serializes', () => {
    const serialized = JSON.stringify(toSessionState(GET_SESSION_RESPONSE))
    expect(serialized).not.toContain('THE-LIVE-SESSION-TOKEN')
    expect(serialized).not.toContain('sess_01ABC')
    expect(serialized).not.toContain('203.0.113.7')
    expect(serialized).not.toContain('Mozilla')
    expect(serialized).not.toContain('session')
  })

  it('keeps exactly the fields the dashboard renders and nothing else', () => {
    expect(toSessionState(GET_SESSION_RESPONSE)).toEqual({
      status: 'authenticated',
      user: {
        id: 'u1',
        name: 'Dev User',
        email: 'dev@statesman.test',
        image: null
      }
    })
  })

  it('reads an empty body as anonymous rather than authenticated', () => {
    expect(toSessionState(null)).toEqual({ status: 'anonymous' })
    expect(toSessionState({})).toEqual({ status: 'anonymous' })
    expect(toSessionState({ session: GET_SESSION_RESPONSE.session })).toEqual({
      status: 'anonymous'
    })
  })

  it('refuses a malformed user rather than trusting the shape', () => {
    expect(toSessionState({ user: { id: 'u1' } })).toEqual({ status: 'anonymous' })
    expect(toSessionState({ user: { id: 1, name: 'x', email: 'y' } })).toEqual({
      status: 'anonymous'
    })
  })
})
