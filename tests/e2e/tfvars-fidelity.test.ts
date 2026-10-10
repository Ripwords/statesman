import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toTfvars } from '../../server/hcl/tfvars'
import type { JsonValue } from '../../shared/schemas/variable'

const run = promisify(execFile)
let dir: string

// The unit tests round-trip through this app's own parser; this asks real
// Terraform, which is what reads the file in the end.
const VALUES: Record<string, JsonValue> = {
  quoted: 'say "hi" \\ C:\\path\\',
  lines: 'line one\nline two\r\n\ttabbed',
  control: 'bell\u0007 backspace\b formfeed\f',
  interpolation: '${var.secret} and %{ if true }x%{ endif }',
  escaped: '$${x} %%{y} $$${z} %%%{w} $$ %% ends with $',
  unicode: 'café 🚀',
  number: -1.5e-7,
  list: [1, 'two', null, [true]],
  map: { '${key}': { 'has space': 'x', 'a"b': 2 } }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'statesman-tfvars-'))
  const declarations = Object.keys(VALUES)
    .map((name) => `variable "${name}" {\n  type = any\n}\n`)
    .join('')
  await writeFile(
    join(dir, 'main.tf'),
    `${declarations}output "all" {\n  value = jsonencode({ ${Object.keys(VALUES)
      .map((name) => `${name} = var.${name}`)
      .join(', ')} })\n}\n`
  )
  await writeFile(join(dir, 'statesman.auto.tfvars'), toTfvars(VALUES))
})

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('toTfvars read by real terraform', () => {
  it('reads back every value exactly', async () => {
    const env = { ...process.env, TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' }
    await run('terraform', ['init', '-no-color'], { cwd: dir, env })
    await run('terraform', ['apply', '-auto-approve', '-no-color'], { cwd: dir, env })
    const { stdout } = await run('terraform', ['output', '-raw', 'all'], { cwd: dir, env })
    // `type = any` turns a mixed list into a tuple and numbers into numbers,
    // which jsonencode writes back in JSON's own terms.
    expect(JSON.parse(stdout)).toEqual(VALUES)
  })
})
