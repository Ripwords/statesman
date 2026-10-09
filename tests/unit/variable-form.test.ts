import { describe, it, expect } from 'vitest'
import { mergeVariables, type StoredVariable } from '../../server/utils/variable-status'
import type { DeclaredVariable } from '../../shared/schemas/variable'
import { seedVariableForm, shownDescription, variablePutBody } from '../../app/utils/variable-form'

const stored = (name: string, extra: Partial<StoredVariable> = {}): StoredVariable => ({
  name,
  sensitive: true,
  description: null,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedByName: null,
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

const rowFor = (s: StoredVariable[], d: DeclaredVariable[]) => {
  const [row] = mergeVariables(s, d)
  if (!row) throw new Error('no row')
  return row
}

describe('seedVariableForm', () => {
  it('starts a new variable as sensitive', () => {
    expect(seedVariableForm(null)).toMatchObject({ sensitive: true, keepsSecret: false })
  })

  it('defaults Sensitive on for a declared, unset variable without `sensitive = true`', () => {
    const form = seedVariableForm(rowFor([], [declared('region')]))
    expect(form.sensitive).toBe(true)
    // What the modal sends when the admin types a value and saves.
    expect(variablePutBody(form, { ok: true, value: 'eu' }, '')).toEqual({
      value: 'eu',
      sensitive: true,
      description: null
    })
  })

  it('does not offer to keep a value that was never stored', () => {
    const form = seedVariableForm(rowFor([], [declared('pw', { sensitive: true })]))
    expect(form.keepsSecret).toBe(false)
  })

  it('keeps the stored secret when the value is left empty', () => {
    const form = seedVariableForm(rowFor([stored('pw')], [declared('pw')]))
    expect(form).toMatchObject({ sensitive: true, keepsSecret: true, valueText: '' })
  })

  it('keeps the stored non-sensitive flag and value', () => {
    const form = seedVariableForm(rowFor([stored('n', { sensitive: false, value: 3 })], []))
    expect(form).toMatchObject({ sensitive: false, keepsSecret: false, jsonMode: true })
    expect(form.valueText).toBe('3')
  })

  it('prefills only the stored description, never the declared fallback', () => {
    const fallback = rowFor([stored('a')], [declared('a', { description: 'from repo' })])
    expect(seedVariableForm(fallback).description).toBe('')
    const own = rowFor(
      [stored('a', { description: 'mine' })],
      [declared('a', { description: 'from repo' })]
    )
    expect(seedVariableForm(own).description).toBe('mine')
  })
})

describe('shownDescription', () => {
  it('shows the declared description when the stored one is empty', () => {
    expect(
      shownDescription(rowFor([stored('a')], [declared('a', { description: 'from repo' })]))
    ).toBe('from repo')
    expect(
      shownDescription(
        rowFor([stored('a', { description: 'mine' })], [declared('a', { description: 'repo' })])
      )
    ).toBe('mine')
  })
})
