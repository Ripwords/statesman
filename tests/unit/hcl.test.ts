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

describe('parseTfvars refuses everything that is not a literal (R14)', () => {
  const attempt = (source: string) => () => hcl.parseTfvars(source)
  const hclError = (line = 1) => expect.objectContaining({ name: 'HclError', line })

  it.each([
    ['get_attr on an object', 'a = {x=1}.x\n'],
    ['index on a tuple', 'a = [1][0]\n'],
    ['index on a string', 'a = "s"[0]\n'],
    ['index on a number', 'a = 5[0]\n'],
    ['attribute splat', 'a = [1].*\n'],
    ['full splat', 'a = [1][*]\n'],
    ['nested postfix', 'a = { b = [1,2][1] }\n'],
    ['logical not', 'a = !true\n'],
    ['double negation', 'a = - -1\n'],
    ['negated string', 'a = -"x"\n']
  ])('refuses %s', (_label, source) => expect(attempt(source)).toThrow(hclError()))

  it.each([
    ['an if directive', 'a = <<EOT\n%{ if true }x%{ endif }\nEOT\n'],
    ['a for directive', 'a = <<EOT\n%{ for i in [1] }${i}%{ endfor }\nEOT\n'],
    ['an interpolation', 'a = <<EOT\nhello ${var.x}\nEOT\n']
  ])('refuses a heredoc with %s', (_label, source) => expect(attempt(source)).toThrow(hclError(2)))

  it('names quoted templates accurately', () => {
    expect(() => hcl.parseTfvars('a = "${var.x}"\n')).toThrow(/templates are not allowed/)
  })

  it('unescapes $${ and %%{ in strings and heredocs', () => {
    expect(hcl.parseTfvars('a = "$${x} %%{y}"\n')).toEqual({ a: '${x} %{y}' })
    expect(hcl.parseTfvars('a = <<EOT\n$${x} %%{y}\nEOT\n')).toEqual({ a: '${x} %{y}\n' })
  })

  it('refuses duplicate keys at the second occurrence', () => {
    expect(attempt('a = 1\na = 2\n')).toThrow(hclError(2))
    expect(attempt('a = {\n  x = 1\n  x = 2\n}\n')).toThrow(hclError(3))
    expect(attempt('a = { x = 1, "x" = 2 }\n')).toThrow(hclError(1))
  })

  it('refuses two attributes on one line', () => {
    expect(attempt('a = 1 b = 2\n')).toThrow(hclError())
  })

  it('reads negative numbers', () => {
    expect(hcl.parseTfvars('a = -1\nb = -1.5\n')).toEqual({ a: -1, b: -1.5 })
  })

  it('stringifies number, bool and null object keys', () => {
    expect(hcl.parseTfvars('a = { 1 = 2, true = 3, null = 4 }\n')).toEqual({
      a: { '1': 2, true: 3, null: 4 }
    })
  })

  it('refuses exponent numbers (the grammar rejects them)', () => {
    expect(attempt('a = 1e3\n')).toThrow(hclError())
  })

  it('refuses integers that lose precision', () => {
    expect(attempt('a = 12345678901234567890\n')).toThrow(hclError())
    expect(hcl.parseTfvars('a = 9007199254740991\n')).toEqual({ a: 9007199254740991 })
  })

  it('refuses nesting beyond the cap with an HclError, not a RangeError', () => {
    expect(attempt(`a = ${'['.repeat(200)}${']'.repeat(200)}\n`)).toThrow(hclError())
    expect(attempt(`a = ${'['.repeat(20000)}\n`)).toThrow(hclError())
  })

  it('does not leak parse trees', () => {
    let last: unknown
    for (let i = 0; i < 200; i++) last = hcl.parseTfvars('a = 1\n')
    expect(last).toEqual({ a: 1 })
  })
})

describe('extractVariables, round 1', () => {
  const extract = (source: string) => hcl.extractVariables(source, 'v.tf')

  it('accepts a bare identifier label', () => {
    expect(extract('variable foo {}\n').map((v) => v.name)).toEqual(['foo'])
  })

  it.each([
    ['no label', 'variable {}\n'],
    ['two labels', 'variable "a" "b" {}\n']
  ])('refuses a variable block with %s', (_label, source) => {
    expect(() => extract(source)).toThrow(expect.objectContaining({ name: 'HclError', line: 1 }))
  })

  it('converts "true" and "false" strings for sensitive', () => {
    expect(extract('variable "a" { sensitive = "true" }\n')[0]?.sensitive).toBe(true)
    expect(extract('variable "a" { sensitive = "false" }\n')[0]?.sensitive).toBe(false)
  })

  it.each([['"yes"'], ['1'], ['null'], ['var.x']])('refuses sensitive = %s', (value) => {
    expect(() => extract(`variable "a" {\n  sensitive = ${value}\n}\n`)).toThrow(
      expect.objectContaining({ name: 'HclError', line: 2 })
    )
  })

  it('refuses two attributes on one line inside a block', () => {
    expect(() => extract('variable "a" { type = string default = 1 }\n')).toThrow(HclError)
  })
})
