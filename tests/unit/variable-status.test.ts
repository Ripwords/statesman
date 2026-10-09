import { describe, it, expect } from 'vitest'
import { mergeVariables, type StoredVariable } from '../../server/utils/variable-status'
import type { DeclaredVariable } from '../../shared/schemas/variable'

const stored = (name: string, extra: Partial<StoredVariable> = {}): StoredVariable => ({
  name,
  sensitive: true,
  description: null,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u1',
  ...extra
})
const declared = (name: string, extra: Partial<DeclaredVariable> = {}): DeclaredVariable => ({
  name,
  typeExpr: 'string',
  hasDefault: false,
  sensitive: false,
  description: null,
  file: 'variables.tf',
  line: 1,
  ...extra
})

describe('mergeVariables', () => {
  it('reports no status at all without a declared set', () => {
    const rows = mergeVariables([stored('a')], null)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBeNull()
  })

  it('classifies all four statuses', () => {
    const rows = mergeVariables(
      [stored('set_one'), stored('extra')],
      [declared('set_one'), declared('need'), declared('opt', { hasDefault: true })]
    )
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.status]))
    expect(byName).toEqual({
      set_one: 'set',
      extra: 'undeclared',
      need: 'missing',
      opt: 'optional'
    })
  })

  it('puts missing first, then sorts by name', () => {
    const rows = mergeVariables(
      [stored('b'), stored('a')],
      [declared('z'), declared('a'), declared('b')]
    )
    expect(rows.map((r) => r.name)).toEqual(['z', 'a', 'b'])
  })

  it('falls back to the declared description', () => {
    const rows = mergeVariables([stored('a')], [declared('a', { description: 'from repo' })])
    expect(rows[0]?.description).toBe('from repo')
  })

  it('prefers the stored description', () => {
    const rows = mergeVariables(
      [stored('a', { description: 'mine' })],
      [declared('a', { description: 'repo' })]
    )
    expect(rows[0]?.description).toBe('mine')
  })

  it('never carries a value for a sensitive row', () => {
    const rows = mergeVariables([stored('a', { sensitive: true, value: 'leak' })], null)
    expect(rows[0]).not.toHaveProperty('value')
  })

  it('carries a non-sensitive value', () => {
    const rows = mergeVariables([stored('a', { sensitive: false, value: 3 })], null)
    expect(rows[0]?.value).toBe(3)
  })
})
