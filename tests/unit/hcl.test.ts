import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHclToolkit, HclError, type HclToolkit } from '../../server/hcl/toolkit'

let hcl: HclToolkit
const fixture = (name: string) => readFileSync(join('tests/unit/fixtures/hcl', name), 'utf8')

beforeAll(async () => {
  hcl = await createHclToolkit(async (name) => readFileSync(join('server/assets/wasm', name)))
})

describe('extractVariables', () => {
  it('finds every variable block and nothing else', () => {
    const vars = hcl.extractVariables(fixture('variables.tf'), 'variables.tf')
    expect(vars.map((v) => v.name)).toEqual(['region', 'db_password', 'tags', 'untyped'])
  })

  it('reads type, default, sensitive and description', () => {
    const [region, password, tags, untyped] = hcl.extractVariables(
      fixture('variables.tf'),
      'variables.tf'
    )
    expect(region).toEqual({
      name: 'region',
      typeExpr: 'string',
      hasDefault: true,
      sensitive: false,
      description: 'AWS region',
      file: 'variables.tf',
      line: 1
    })
    expect(password?.sensitive).toBe(true)
    expect(password?.description).toBe('The database password.\nRotated quarterly.')
    expect(tags?.typeExpr).toBe('map(object({ team = string, cost = optional(number) }))')
    expect(tags?.hasDefault).toBe(false)
    expect(untyped).toMatchObject({ typeExpr: null, hasDefault: false, description: null })
  })

  it('returns nothing for a file without variables', () => {
    expect(hcl.extractVariables('locals { a = 1 }\n', 'main.tf')).toEqual([])
  })

  it('throws HclError with the file and line of a syntax error', () => {
    const attempt = () => hcl.extractVariables(fixture('broken.tf'), 'broken.tf')
    expect(attempt).toThrow(HclError)
    expect(attempt).toThrow(expect.objectContaining({ file: 'broken.tf' }))
    let line = 0
    try {
      attempt()
    } catch (error) {
      line = error instanceof HclError ? error.line : 0
    }
    expect(line).toBeGreaterThanOrEqual(3)
  })
})

describe('parseTfvars', () => {
  it('converts literal values to JSON', () => {
    const source = [
      'region   = "eu-west-1"',
      'replicas = 3',
      'ratio    = 0.5',
      'enabled  = true',
      'nothing  = null',
      'zones    = ["a", "b"]',
      'tags     = { team = "core", "cost-centre" = 42 }',
      'notes    = <<EOT',
      'line one',
      'EOT'
    ].join('\n')
    expect(hcl.parseTfvars(source)).toEqual({
      region: 'eu-west-1',
      replicas: 3,
      ratio: 0.5,
      enabled: true,
      nothing: null,
      zones: ['a', 'b'],
      tags: { team: 'core', 'cost-centre': 42 },
      notes: 'line one\n'
    })
  })

  it('unescapes quoted strings', () => {
    expect(hcl.parseTfvars('a = "tab\\tquote\\"nl\\n"\n')).toEqual({ a: 'tab\tquote"nl\n' })
  })

  it.each([
    ['an interpolation', 'a = "${var.x}"\n', 1],
    ['a function call', 'a = 1\nb = file("x")\n', 2],
    ['a reference', 'a = local.y\n', 1],
    ['an operation', 'a = 1 + 1\n', 1]
  ])('refuses %s with its line', (_label, source, line) => {
    expect(() => hcl.parseTfvars(source)).toThrow(expect.objectContaining({ line }))
  })

  it('refuses a block', () => {
    expect(() => hcl.parseTfvars('variable "x" {}\n')).toThrow(HclError)
  })
})
