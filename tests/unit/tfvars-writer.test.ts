import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHclToolkit, type HclToolkit } from '../../server/hcl/toolkit'
import { toTfvars } from '../../server/hcl/tfvars'
import type { JsonValue } from '../../shared/schemas/variable'

let hcl: HclToolkit

beforeAll(async () => {
  hcl = await createHclToolkit(async (name) => readFileSync(join('server/assets/wasm', name)))
})

const roundTrip = (values: Record<string, JsonValue>) => hcl.parseTfvars(toTfvars(values))

describe('toTfvars', () => {
  it('writes one attribute per variable, in the order given', () => {
    expect(toTfvars({ region: 'eu-west-1', replicas: 3 })).toBe(
      'region = "eu-west-1"\nreplicas = 3\n'
    )
  })

  it('writes nothing for no variables', () => {
    expect(toTfvars({})).toBe('')
  })

  it('round-trips every kind of value through the parser', () => {
    const values: Record<string, JsonValue> = {
      region: 'eu-west-1',
      replicas: 3,
      ratio: 0.5,
      negative: -12,
      tiny: 1e-7,
      small: -2.5e-8,
      enabled: true,
      disabled: false,
      nothing: null,
      zones: ['a', 'b'],
      empty_list: [],
      empty_map: {},
      tags: { team: 'core', 'cost-centre': 42, 'has space': 'x', '': 'blank key' },
      nested: { list: [{ a: [1, [2, null]] }], deep: { deeper: { deepest: true } } },
      'kebab-name': 'ok'
    }
    expect(roundTrip(values)).toEqual(values)
  })

  it.each([
    ['quotes and backslashes', 'say "hi" \\ C:\\path\\'],
    ['newlines and tabs', 'line one\nline two\r\n\ttabbed'],
    ['control characters', 'bell\u0007 backspace\b formfeed\f nul\u0000'],
    ['an interpolation', '${var.secret}'],
    ['a directive', '%{ if true }x%{ endif }'],
    ['already-escaped markers', '$${x} %%{y} $$${z} %%%{w}'],
    ['marker runs without a brace', '$$ %% $$$ x'],
    ['lone markers', 'cost $5, 100% sure, $ { and % {'],
    ['unicode', 'café 🚀 \u2028'],
    ['a trailing dollar', 'ends with $']
  ])('keeps %s literal', (_label, value) => {
    expect(roundTrip({ v: value, inside: { k: value }, list: [value] })).toEqual({
      v: value,
      inside: { k: value },
      list: [value]
    })
  })

  it('puts a fraction before every exponent', () => {
    expect(toTfvars({ a: 1e21, b: -1e-7, c: 1.5e-7 })).toBe(
      'a = 1.0e+21\nb = -1.0e-7\nc = 1.5e-7\n'
    )
  })

  it('quotes map keys so any key survives', () => {
    expect(roundTrip({ m: { '${x}': 1, 'a"b': 2, 'line\nbreak': 3 } })).toEqual({
      m: { '${x}': 1, 'a"b': 2, 'line\nbreak': 3 }
    })
  })
})
