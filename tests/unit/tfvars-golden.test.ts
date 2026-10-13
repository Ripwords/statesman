import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { toTfvars } from '../../shared/hcl/tfvars'
import { GOLDEN_INPUT } from './fixtures/tfvars/golden-input'

// Output of toTfvars before it moved to shared/. Any change to this text is a
// change to every file the dashboard, /api/vars and the CLI write.
describe('toTfvars golden output', () => {
  it('matches the recorded output byte for byte', () => {
    const golden = readFileSync('tests/unit/fixtures/tfvars/golden.tfvars', 'utf8')
    expect(toTfvars(GOLDEN_INPUT)).toBe(golden)
  })
})
