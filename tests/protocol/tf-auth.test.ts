import { describe, it, expect } from 'vitest'
import { parseBasicAuth, scopeAllows } from '../../server/utils/tf-auth'
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
