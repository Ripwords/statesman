import { describe, it, expect } from 'vitest'
import { isBlockedAuthPath } from '../../server/utils/blocked-auth-paths'

const ORIGIN = 'http://localhost:3000'

// Raw request targets as a client can send them. better-call routes on
// `new URL(request.url).pathname`, which resolves dot-segments, so every
// spelling below reaches the same plugin endpoint unless it is refused.
const BLOCKED = [
  '/api/auth/organization/update-member-role',
  '/api/auth/organization/update-member-role/',
  '/api/auth/organization/update-member-role?x=1',
  '/api/auth/organization/leave',
  '/api/auth/organization/check-slug',
  '/api/auth/organization',
  '/api/auth/./organization/update-member-role',
  '/api/auth/%2e/organization/update-member-role',
  '/api/auth/%2E/organization/update-member-role',
  '/api/auth/x/../organization/update-member-role',
  '/api/auth/x/%2e%2e/organization/update-member-role',
  '/api/auth/x/%2E%2E/organization/update-member-role',
  '/api/auth/x\\..\\organization/update-member-role',
  '/api/auth//organization/update-member-role',
  '/api/auth/%6Frganization/update-member-role',
  '/api/auth/Organization/update-member-role',
  '/api/auth/organization%2Fupdate-member-role',
  '/api/auth/x/%252e%252e/organization/update-member-role',
  '/api/auth/sign-in%3F/../organization/update-member-role',
  '/api/auth/x/%2F%2Fy/../../organization/update-member-role',
  '/api/auth/api-key/create',
  '/api/auth/api-key/create/',
  '/api/auth/%2e/api-key/create',
  '/api/auth/x/../api-key/create',
  '/api/auth/api-key/update',
  '/api/auth/./api-key/update',
  '/api/auth/x/%2e%2e/api-key/update'
]

// Endpoints the dashboard and the plugin's own self-scoped routes still need.
const ALLOWED = [
  '/api/auth/sign-in/email',
  '/api/auth/get-session',
  '/api/auth/sign-out',
  '/api/auth/api-key/list',
  '/api/auth/api-key/get',
  '/api/auth/api-key/delete',
  '/api/auth/organizations-are-not-a-route'
]

describe('isBlockedAuthPath', () => {
  it.each(BLOCKED)('refuses %s', (path) => {
    expect(isBlockedAuthPath(ORIGIN + path)).toBe(true)
  })

  it.each(ALLOWED)('lets %s through', (path) => {
    expect(isBlockedAuthPath(ORIGIN + path)).toBe(false)
  })

  it('refuses a URL it cannot decode rather than guess', () => {
    expect(isBlockedAuthPath(`${ORIGIN}/api/auth/%E0%A4%A/organization/leave`)).toBe(true)
  })
})
