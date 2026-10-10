import { describe, it, expect } from 'vitest'
import { updateProjectSchema } from '../../shared/schemas/project'
import { effectiveRetention } from '../../shared/retention'

describe('updateProjectSchema', () => {
  it('trims the name', () => {
    expect(updateProjectSchema.parse({ name: '  Prod  ' })).toEqual({ name: 'Prod' })
  })

  it.each(['', '   ', 'x'.repeat(65)])('rejects name %j', (name) => {
    expect(updateProjectSchema.safeParse({ name }).success).toBe(false)
  })

  it('stores a blank description as null', () => {
    expect(updateProjectSchema.parse({ description: '  ' })).toEqual({ description: null })
  })

  it('rejects a 501 character description', () => {
    expect(updateProjectSchema.safeParse({ description: 'x'.repeat(501) }).success).toBe(false)
  })

  it('accepts null retention as "use the default"', () => {
    expect(updateProjectSchema.parse({ retentionKeepDays: null })).toEqual({
      retentionKeepDays: null
    })
  })

  it.each([0, -1, 1.5])('rejects retention %j', (n) => {
    expect(updateProjectSchema.safeParse({ retentionKeepVersions: n }).success).toBe(false)
  })

  it('rejects a slug, which is not a setting', () => {
    expect(updateProjectSchema.safeParse({ slug: 'other' }).success).toBe(false)
  })
})

describe('effectiveRetention', () => {
  const defaults = { keepVersions: 100, keepDays: 30 }

  it('falls back to the deployment default per field', () => {
    expect(effectiveRetention({ keepVersions: 5, keepDays: null }, defaults)).toEqual({
      keepVersions: 5,
      keepDays: 30,
      source: { versions: 'project', days: 'default' }
    })
  })

  it('uses the defaults when nothing is overridden', () => {
    expect(effectiveRetention({ keepVersions: null, keepDays: null }, defaults)).toEqual({
      ...defaults,
      source: { versions: 'default', days: 'default' }
    })
  })
})
