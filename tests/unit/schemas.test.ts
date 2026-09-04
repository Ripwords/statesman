import { describe, it, expect } from 'vitest'
import { lockInfoSchema } from '../../shared/schemas/lock'
import { tokenConfigSchema } from '../../shared/schemas/token'
import { projectRefSchema } from '../../shared/schemas/project'

describe('lockInfoSchema', () => {
  it('accepts what terraform actually sends', () => {
    const parsed = lockInfoSchema.parse({
      ID: '90f1e2d3-0000-4000-8000-000000000000',
      Operation: 'OperationTypeApply',
      Info: '',
      Who: 'jj@laptop',
      Version: '1.9.5',
      Created: '2026-09-04T10:00:00.123456Z',
      Path: ''
    })
    expect(parsed.ID).toBe('90f1e2d3-0000-4000-8000-000000000000')
  })

  it('requires an ID', () => {
    expect(() => lockInfoSchema.parse({ Who: 'jj' })).toThrow()
  })

  it('tolerates absent optional fields', () => {
    expect(lockInfoSchema.parse({ ID: 'abc' }).Who).toBeUndefined()
  })
})

describe('tokenConfigSchema', () => {
  it('accepts a scoped token', () => {
    const parsed = tokenConfigSchema.parse({
      name: 'ci-prod',
      actions: ['read', 'write', 'lock'],
      scope: { kind: 'projects', projects: ['acme/prod'] },
      expiresInDays: 90
    })
    expect(parsed.scope.kind).toBe('projects')
  })

  it('accepts an account-wide token', () => {
    expect(tokenConfigSchema.parse({
      name: 'all', actions: ['read'], scope: { kind: 'all' }
    }).scope.kind).toBe('all')
  })

  it('rejects a projects scope with an empty list', () => {
    expect(() => tokenConfigSchema.parse({
      name: 'bad', actions: ['read'], scope: { kind: 'projects', projects: [] }
    })).toThrow()
  })

  it('rejects an unknown action', () => {
    expect(() => tokenConfigSchema.parse({
      name: 'bad', actions: ['sudo'], scope: { kind: 'all' }
    })).toThrow()
  })

  it('rejects an empty name', () => {
    expect(() => tokenConfigSchema.parse({
      name: '', actions: ['read'], scope: { kind: 'all' }
    })).toThrow()
  })
})

describe('projectRefSchema', () => {
  it('accepts a well-formed slug pair', () => {
    expect(projectRefSchema.parse({ org: 'acme', project: 'my-app-prod' }).org).toBe('acme')
  })

  it('rejects path traversal in a slug', () => {
    expect(() => projectRefSchema.parse({ org: '..', project: 'x' })).toThrow()
    expect(() => projectRefSchema.parse({ org: 'a', project: 'a/b' })).toThrow()
  })
})
