import { describe, it, expect } from 'vitest'
import {
  variableNameSchema,
  variableValueSchema,
  setVariableSchema,
  importVariablesSchema,
  variableAad,
  MAX_VALUE_BYTES
} from '../../shared/schemas/variable'

describe('variableNameSchema', () => {
  it.each(['region', '_x', 'db-password', 'A1_b-2'])('accepts %s', (name) => {
    expect(variableNameSchema.safeParse(name).success).toBe(true)
  })
  it.each(['', '1abc', 'has space', 'dot.ted', 'a/b', 'x'.repeat(129)])('refuses %j', (name) => {
    expect(variableNameSchema.safeParse(name).success).toBe(false)
  })
})

describe('variableValueSchema', () => {
  it.each([['s'], [3], [true], [null], [['a', 1]], [{ a: { b: [1] } }]])('accepts %j', (v) => {
    expect(variableValueSchema.safeParse(v).success).toBe(true)
  })
  it('refuses a value over 64 KiB', () => {
    expect(variableValueSchema.safeParse('x'.repeat(MAX_VALUE_BYTES)).success).toBe(false)
  })
  it('accepts a value exactly at the limit once serialised', () => {
    // JSON.stringify adds two quote characters.
    expect(variableValueSchema.safeParse('x'.repeat(MAX_VALUE_BYTES - 2)).success).toBe(true)
  })
})

describe('setVariableSchema', () => {
  it('defaults sensitive to true', () => {
    expect(setVariableSchema.parse({ value: 'v' }).sensitive).toBe(true)
  })
  it('allows value to be omitted', () => {
    expect(setVariableSchema.parse({ sensitive: true }).value).toBeUndefined()
  })
})

describe('importVariablesSchema', () => {
  it('accepts a values map', () => {
    expect(importVariablesSchema.parse({ values: { a: 1 } })).toMatchObject({ dryRun: false })
  })
  it('accepts hcl source', () => {
    expect(importVariablesSchema.parse({ hcl: 'a = 1', dryRun: true }).dryRun).toBe(true)
  })
  it('refuses a bad name inside values', () => {
    expect(importVariablesSchema.safeParse({ values: { '1bad': 1 } }).success).toBe(false)
  })
  it('refuses more than 500 values', () => {
    const values = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`v${i}`, i]))
    expect(importVariablesSchema.safeParse({ values }).success).toBe(false)
  })
})

describe('variableAad', () => {
  it('binds environment and name', () => {
    expect(variableAad('e1', 'x').toString('utf8')).toBe('variable:e1:x')
  })
})
