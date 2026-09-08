import { describe, it, expect } from 'vitest'
import { cronAuthOutcome } from '../../server/utils/cron-auth'

const SECRET = 'a-long-enough-cron-secret-value'

describe('cronAuthOutcome', () => {
  it('accepts the exact bearer token', () => {
    expect(cronAuthOutcome({ secret: SECRET, authorization: `Bearer ${SECRET}` })).toBe('ok')
  })

  /**
   * An unset secret must not degrade into an open endpoint. 404 rather than
   * 401, because the route genuinely is not configured on this deployment —
   * answering 401 would advertise a door that cannot be opened at all.
   */
  it('reports the route as absent when no secret is configured', () => {
    expect(cronAuthOutcome({ secret: undefined, authorization: 'Bearer anything' })).toBe(
      'not-configured'
    )
    expect(cronAuthOutcome({ secret: '', authorization: 'Bearer anything' })).toBe('not-configured')
  })

  it('refuses a missing Authorization header', () => {
    expect(cronAuthOutcome({ secret: SECRET, authorization: undefined })).toBe('denied')
  })

  it('refuses the wrong secret', () => {
    expect(cronAuthOutcome({ secret: SECRET, authorization: 'Bearer not-the-secret' })).toBe(
      'denied'
    )
  })

  it('refuses a secret that is merely a prefix of the real one', () => {
    expect(
      cronAuthOutcome({ secret: SECRET, authorization: `Bearer ${SECRET.slice(0, -1)}` })
    ).toBe('denied')
  })

  it('refuses a secret with anything appended', () => {
    expect(cronAuthOutcome({ secret: SECRET, authorization: `Bearer ${SECRET}x` })).toBe('denied')
  })

  it('refuses a non-bearer scheme carrying the right value', () => {
    expect(cronAuthOutcome({ secret: SECRET, authorization: `Basic ${SECRET}` })).toBe('denied')
    expect(cronAuthOutcome({ secret: SECRET, authorization: SECRET })).toBe('denied')
  })

  it('accepts the scheme case-insensitively, because HTTP says it is', () => {
    expect(cronAuthOutcome({ secret: SECRET, authorization: `bearer ${SECRET}` })).toBe('ok')
    expect(cronAuthOutcome({ secret: SECRET, authorization: `BEARER ${SECRET}` })).toBe('ok')
  })

  it('does not treat an empty bearer value as a match for an empty-ish secret', () => {
    expect(cronAuthOutcome({ secret: SECRET, authorization: 'Bearer ' })).toBe('denied')
    expect(cronAuthOutcome({ secret: SECRET, authorization: 'Bearer' })).toBe('denied')
  })
})
