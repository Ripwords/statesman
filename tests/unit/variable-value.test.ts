import { describe, it, expect } from 'vitest'
import { parseEditorValue, formatValue } from '../../app/utils/variable-value'

describe('parseEditorValue', () => {
  it.each(['3', 'true', 'null', '[1]', '{"a":1}', ''])('string mode keeps %j a string', (text) => {
    expect(parseEditorValue(text, 'string')).toEqual({ ok: true, value: text })
  })
  it('json mode parses structures and scalars', () => {
    expect(parseEditorValue('{"a":[1,true]}', 'json')).toEqual({
      ok: true,
      value: { a: [1, true] }
    })
    expect(parseEditorValue('3', 'json')).toEqual({ ok: true, value: 3 })
  })
  it('json mode reports invalid input', () => {
    const result = parseEditorValue('{a:1}', 'json')
    expect(result.ok).toBe(false)
  })
})

describe('formatValue', () => {
  it('shows strings bare and everything else as JSON', () => {
    expect(formatValue('eu-west-1')).toBe('eu-west-1')
    expect(formatValue(3)).toBe('3')
    expect(formatValue({ a: 1 })).toBe('{"a":1}')
  })
})
