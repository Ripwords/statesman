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

  // The fallback is the panel's (`shownDescription`): a merged value here would
  // prefill the edit form and be saved as if an admin had typed it.
  it('keeps the declared description apart from the stored one', () => {
    const rows = mergeVariables([stored('a')], [declared('a', { description: 'from repo' })])
    expect(rows[0]?.description).toBeNull()
    expect(rows[0]?.declared?.description).toBe('from repo')
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

  it('reports an empty stored description as none', () => {
    const rows = mergeVariables(
      [stored('a', { description: '' })],
      [declared('a', { description: 'repo' })]
    )
    expect(rows[0]?.description).toBeNull()
  })

  it('reports an unstored row as sensitive whatever the block declares', () => {
    const rows = mergeVariables([], [declared('a', { sensitive: false })])
    expect(rows[0]?.sensitive).toBe(true)
  })

  it('sorts by code point, so uppercase precedes lowercase', () => {
    const rows = mergeVariables([stored('a'), stored('B')], [declared('a'), declared('B')])
    expect(rows.map((r) => r.name)).toEqual(['B', 'a'])
  })

  it('keeps missing rows first when sorting by code point', () => {
    const rows = mergeVariables([stored('a')], [declared('a'), declared('Z')])
    expect(rows.map((r) => r.name)).toEqual(['Z', 'a'])
  })

  it('gives a stored row a non-null status when the declared list is empty', () => {
    const rows = mergeVariables([stored('a')], [])
    expect(rows[0]?.status).toBe('undeclared')
  })

  it('marks a declared-only row as not stored, with no updatedAt', () => {
    const rows = mergeVariables([], [declared('need')])
    expect(rows[0]).toMatchObject({
      name: 'need',
      status: 'missing',
      stored: false,
      updatedAt: null,
      updatedBy: null
    })
  })

  it('uses the stored sensitive flag over the declared one', () => {
    const rows = mergeVariables(
      [stored('a', { sensitive: false, value: 1 })],
      [declared('a', { sensitive: true })]
    )
    expect(rows[0]?.sensitive).toBe(false)
    expect(rows[0]?.value).toBe(1)
  })
})
