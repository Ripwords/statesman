import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHclToolkit, type HclToolkit } from '../../server/hcl/toolkit'
import {
  describeDiff,
  diffMaps,
  isEmptyDiff,
  LocalParseError,
  parseLocal
} from '../../cli/src/compare'

let hcl: HclToolkit
beforeAll(async () => {
  hcl = await createHclToolkit(async (name) => readFileSync(join('server/assets/wasm', name)))
})

function thrown(run: () => unknown): Error {
  try {
    run()
  } catch (e) {
    if (e instanceof Error) return e
  }
  return new Error('expected a throw')
}

describe('parseLocal', () => {
  it('reads a hand-formatted .tfvars file the same as rendered output', () => {
    const hand = '# comment\nregion="r"\n\n  count   =   3\ntags = {\n  b = 2\n  a = 1\n}\n'
    expect(parseLocal(hand, 'x.tfvars', hcl)).toEqual({
      region: 'r',
      count: 3,
      tags: { a: 1, b: 2 }
    })
  })
  it('reads .tfvars.json', () => {
    expect(parseLocal('{"a":1}', 'x.tfvars.json', hcl)).toEqual({ a: 1 })
  })
  it('reports an expression with its file and line, never the value', () => {
    const error = thrown(() => parseLocal('a = "secret-value"\nb = var.x\n', 'client.tfvars', hcl))
    expect(error).toBeInstanceOf(LocalParseError)
    expect(error.message).toMatch(/^client\.tfvars:2: /)
    expect(error.message).not.toContain('secret-value')
  })
  it('keeps the reason intact when the file name contains ": "', () => {
    const error = thrown(() => parseLocal('a = 1\nb = var.x\n', 'we: ird.tfvars', hcl))
    expect(error).toBeInstanceOf(LocalParseError)
    expect(error.message).toMatch(/^we: ird\.tfvars:2: expressions are not allowed/)
  })
  it('reports JSON that is not an object', () => {
    expect(() => parseLocal('[1]', 'x.tfvars.json', hcl)).toThrow(LocalParseError)
    expect(() => parseLocal('{', 'x.tfvars.json', hcl)).toThrow(/^x\.tfvars\.json: /)
  })
})

describe('diffMaps', () => {
  it('matches deeply equal maps regardless of key order', () => {
    expect(isEmptyDiff(diffMaps({ a: { x: 1, y: [1, 2] } }, { a: { y: [1, 2], x: 1 } }))).toBe(true)
  })
  it('names each kind of difference, sorted, without values', () => {
    const d = diffMaps({ a: 1, b: 'new', c: 3 }, { b: 'old', c: 3, z: 9 })
    expect(d).toEqual({ onlyInStatesman: ['a'], onlyLocal: ['z'], changed: ['b'] })
    const text = describeDiff(d).join(' ')
    expect(text).toBe('b +a -z')
    expect(text).not.toContain('new')
    expect(text).not.toContain('old')
  })
  it('treats 1 and "1" as different', () => {
    expect(diffMaps({ a: 1 }, { a: '1' }).changed).toEqual(['a'])
  })
})
