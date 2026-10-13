import { describe, it, expect } from 'vitest'
import { renderBackend, renderVars } from '../../cli/src/render'

describe('renderVars', () => {
  it('writes HCL for .tfvars', () => {
    expect(renderVars({ b: 1, a: 'x' }, 'client.tfvars')).toBe('a = "x"\nb = 1\n')
  })
  it('writes sorted, indented JSON with a newline for .tfvars.json', () => {
    expect(renderVars({ b: 1, a: 'x' }, 'client.tfvars.json')).toBe('{\n  "a": "x",\n  "b": 1\n}\n')
  })
})

describe('renderBackend', () => {
  it('writes a flat HCL file', () => {
    expect(renderBackend({ region: 'r', bucket: 'b', encrypt: true })).toBe(
      'bucket = "b"\nencrypt = true\nregion = "r"\n'
    )
  })
})
