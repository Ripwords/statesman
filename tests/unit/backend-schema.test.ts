import { describe, it, expect } from 'vitest'
import {
  backendSettingsSchema,
  firstIssueMessage,
  isCredentialKey,
  putBackendSchema
} from '../../shared/schemas/backend'

const parse = (v: unknown) => backendSettingsSchema.safeParse(v)

describe('backendSettingsSchema', () => {
  it('accepts a flat map of strings, numbers and booleans', () => {
    const r = parse({ bucket: 'b', region: 'ap-southeast-1', encrypt: true, max_retries: 5 })
    expect(r.success).toBe(true)
  })

  it.each([
    'access_key',
    'secret_key',
    'token',
    'password',
    'client_secret',
    'sas_token',
    'db_password'
  ])('refuses credential-like key %s and names it', (key) => {
    const r = parse({ [key]: 'x' })
    expect(r.success).toBe(false)
    const message = r.success ? '' : firstIssueMessage(r.error)
    expect(message).toContain(key)
    expect(message).toContain('unencrypted')
  })

  it('refuses keys that are not lowercase identifiers', () => {
    for (const key of ['ACCESS_KEY', 'Bucket', '1bucket', 'bad-key', '']) {
      expect(parse({ [key]: 'x' }).success).toBe(false)
    }
  })

  it('refuses nested values and null', () => {
    expect(parse({ assume_role: { role_arn: 'x' } }).success).toBe(false)
    expect(parse({ list: ['a'] }).success).toBe(false)
    expect(parse({ empty: null }).success).toBe(false)
  })

  it('refuses a string longer than 2048 characters', () => {
    expect(parse({ bucket: 'x'.repeat(2049) }).success).toBe(false)
    expect(parse({ bucket: 'x'.repeat(2048) }).success).toBe(true)
  })

  it('refuses more than 32 keys', () => {
    const map = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']))
    expect(parse(map).success).toBe(false)
  })

  it('isCredentialKey does not flag ordinary keys', () => {
    for (const key of ['bucket', 'kms_key_id', 'token_endpoint', 'use_lockfile']) {
      expect(isCredentialKey(key)).toBe(false)
    }
  })
})

describe('putBackendSchema', () => {
  it('takes a map, null, or HCL text', () => {
    expect(putBackendSchema.safeParse({ backend: { bucket: 'b' } }).success).toBe(true)
    expect(putBackendSchema.safeParse({ backend: null }).success).toBe(true)
    expect(putBackendSchema.safeParse({ hcl: 'bucket = "b"' }).success).toBe(true)
    expect(putBackendSchema.safeParse({}).success).toBe(false)
  })
})
