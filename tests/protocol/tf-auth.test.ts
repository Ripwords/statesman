import { isApiError } from '../ui/nitro-globals'
import { describe, it, expect } from 'vitest'
import {
  authorizeTf,
  authorizeVars,
  parseBasicAuth,
  scopeAllows,
  type TfPrincipal
} from '../../server/utils/tf-auth'
import type { TokenScope } from '../../shared/schemas/token'

describe('parseBasicAuth', () => {
  it('extracts the password, ignoring the username', () => {
    const header = `Basic ${Buffer.from('statesman:sm_secret').toString('base64')}`
    expect(parseBasicAuth(header)).toBe('sm_secret')
  })

  it('handles a password containing colons', () => {
    const header = `Basic ${Buffer.from('u:a:b:c').toString('base64')}`
    expect(parseBasicAuth(header)).toBe('a:b:c')
  })

  it('returns null for a missing header', () => {
    expect(parseBasicAuth(undefined)).toBeNull()
  })

  it('returns null for a non-Basic scheme', () => {
    expect(parseBasicAuth('Bearer sm_secret')).toBeNull()
  })

  it('returns null for an empty password', () => {
    expect(parseBasicAuth(`Basic ${Buffer.from('user:').toString('base64')}`)).toBeNull()
  })

  it('returns null for undecodable base64', () => {
    expect(parseBasicAuth('Basic !!!not-base64!!!')).toBeNull()
  })
})

describe('scopeAllows', () => {
  it('allows any project for an account-wide scope', () => {
    expect(scopeAllows({ kind: 'all' }, 'acme', 'prod')).toBe(true)
  })

  it('allows a listed project', () => {
    const scope: TokenScope = { kind: 'projects', projects: ['acme/prod'] }
    expect(scopeAllows(scope, 'acme', 'prod')).toBe(true)
  })

  it('denies an unlisted project', () => {
    const scope: TokenScope = { kind: 'projects', projects: ['acme/prod'] }
    expect(scopeAllows(scope, 'acme', 'staging')).toBe(false)
  })

  it('denies a matching project name in a different org', () => {
    const scope: TokenScope = { kind: 'projects', projects: ['acme/prod'] }
    expect(scopeAllows(scope, 'evil', 'prod')).toBe(false)
  })

  it('denies on a prefix near-match', () => {
    const scope: TokenScope = { kind: 'projects', projects: ['acme/prod'] }
    expect(scopeAllows(scope, 'acme', 'prod-2')).toBe(false)
  })
})

describe('authorizeVars', () => {
  const principal = (over: Partial<TfPrincipal>): TfPrincipal => ({
    userId: 'u',
    keyId: 'k',
    actions: ['read'],
    varActions: [],
    scope: { kind: 'projects', projects: ['acme/prod'] },
    ...over
  })
  const ref = { org: 'acme', project: 'prod' }

  it('refuses a state-only token with 403', () => {
    expect(() => authorizeVars(principal({}), ref)).toThrow(
      expect.objectContaining({ statusCode: 403 })
    )
  })
  it('refuses an out-of-scope token with 403', () => {
    expect(() =>
      authorizeVars(principal({ varActions: ['read'] }), { org: 'acme', project: 'staging' })
    ).toThrow(expect.objectContaining({ statusCode: 403 }))
  })
  it('allows a scoped token with vars read', () => {
    expect(() => authorizeVars(principal({ varActions: ['read'] }), ref)).not.toThrow()
  })

  it('denies every state action to a variables-only token', () => {
    const varsOnly = principal({ actions: [], varActions: ['read'], scope: { kind: 'all' } })
    for (const action of ['read', 'write', 'delete', 'lock'] as const) {
      expect(() => authorizeTf(varsOnly, ref, action)).toThrow(
        expect.objectContaining({ statusCode: 403 })
      )
    }
    expect(() => authorizeVars(varsOnly, ref)).not.toThrow()
    const thrown = (() => {
      try {
        authorizeTf(varsOnly, ref, 'read')
        return null
      } catch (error) {
        return error
      }
    })()
    expect(isApiError(thrown)).toBe(true)
    expect(thrown).toMatchObject({ statusMessage: 'Token does not permit the "read" action' })
  })
  it('still lets a state token without vars use state', () => {
    expect(() => authorizeTf(principal({}), ref, 'read')).not.toThrow()
  })
})
