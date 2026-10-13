import { describe, it, expect } from 'vitest'
import { findStrays } from '../../cli/src/strays'
import type { Manifest } from '../../shared/schemas/manifest'

const manifest: Manifest = {
  server: 'https://s.example.com',
  project: 'acme/p',
  environments: ['internal', 'client'],
  files: { vars: '{env}.tfvars', backend: 'backend.{env}.hcl', env: '.env.{env}' }
}

describe('findStrays', () => {
  it('reports a file matching a pattern for an unlisted environment', () => {
    const entries = ['client.tfvars', '.env.staging', 'backend.old.hcl', 'main.tf']
    expect(findStrays(entries, new Set(), manifest)).toEqual([
      { file: '.env.staging', env: 'staging' },
      { file: 'backend.old.hcl', env: 'old' }
    ])
  })
  it('never reports a git-tracked file such as .env.example', () => {
    expect(findStrays(['.env.example'], new Set(['.env.example']), manifest)).toEqual([])
  })
  it('ignores names whose {env} part is not a valid slug', () => {
    expect(
      findStrays(['backend.hcl.example', 'x.y.tfvars', '.terraform.lock.hcl'], new Set(), manifest)
    ).toEqual([])
  })
  it('reports nothing for a pattern without {env}', () => {
    const single: Manifest = {
      ...manifest,
      environments: ['prod'],
      files: { vars: 'terraform.tfvars' }
    }
    expect(findStrays(['terraform.tfvars', 'other.tfvars'], new Set(), single)).toEqual([])
  })
})
