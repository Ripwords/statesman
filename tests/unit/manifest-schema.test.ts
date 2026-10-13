import { describe, it, expect } from 'vitest'
import { fileFor, parseManifest } from '../../shared/schemas/manifest'

const base = {
  server: 'https://statesman.example.com',
  project: 'acme/sbf-ai',
  environments: ['internal', 'client'],
  files: { vars: '{env}.tfvars', backend: 'backend.{env}.hcl', env: '.env.{env}' }
}
const text = (patch: object) => JSON.stringify({ ...base, ...patch })
const error = (patch: object) => {
  try {
    parseManifest(text(patch))
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected a refusal')
}

describe('parseManifest', () => {
  it('accepts the documented two-environment manifest', () => {
    expect(parseManifest(text({})).environments).toEqual(['internal', 'client'])
  })

  it('accepts terraform.tfvars with a single environment', () => {
    const m = parseManifest(text({ environments: ['prod'], files: { vars: 'terraform.tfvars' } }))
    expect(m.files.vars).toBe('terraform.tfvars')
  })

  it.each([
    'terraform.tfvars',
    'terraform.tfvars.json',
    '{env}.auto.tfvars',
    '{env}.auto.tfvars.json'
  ])('refuses auto-loaded vars name %s with two environments', (vars) => {
    expect(error({ files: { vars } })).toMatch(
      /^statesman\.json: files\.vars: .*loaded by Terraform for every environment/
    )
  })

  it('refuses a pattern without {env} when there are two environments', () => {
    expect(error({ files: { vars: '{env}.tfvars', backend: 'backend.hcl' } })).toContain(
      'files.backend'
    )
  })

  it.each(['../x.tfvars', 'dir/{env}.tfvars', '{env} vars.tfvars', '.', '..'])(
    'refuses unsafe file name %s',
    (vars) => {
      expect(error({ files: { vars } })).toContain('files.vars')
    }
  )

  it('refuses a vars name that is not .tfvars or .tfvars.json', () => {
    expect(error({ files: { vars: '{env}.vars' } })).toContain('files.vars')
  })

  it('refuses duplicate environments, bad slugs, a bad project, unknown fields', () => {
    expect(error({ environments: ['a', 'a'] })).toContain('environments')
    expect(error({ environments: ['Bad_Slug'] })).toContain('environments')
    expect(error({ environments: [] })).toContain('environments')
    expect(error({ project: 'no-slash' })).toContain('project')
    expect(error({ extra: true })).toContain('statesman.json')
  })

  it('refuses a non-http server', () => {
    expect(error({ server: 'ftp://x' })).toContain('server')
  })

  it('reports invalid JSON', () => {
    expect(() => parseManifest('{')).toThrow(/^statesman\.json: not valid JSON/)
  })
})

describe('fileFor', () => {
  it('substitutes every {env}', () => {
    expect(fileFor('{env}/{env}.tfvars', 'client')).toBe('client/client.tfvars')
  })
})
