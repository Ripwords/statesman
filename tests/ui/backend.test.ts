import { describe, expect, it } from 'vitest'
import { backendSnippet } from '../../app/utils/backend'

const base = { origin: 'https://statesman.example.com', org: 'acme', project: 'prod' }

describe('backendSnippet', () => {
  it('addresses the project the user is looking at', () => {
    const snippet = backendSnippet(base)
    expect(snippet).toContain('address        = "https://statesman.example.com/api/tf/acme/prod"')
    expect(snippet).toContain(
      'lock_address   = "https://statesman.example.com/api/tf/acme/prod/lock"'
    )
    expect(snippet).toContain(
      'unlock_address = "https://statesman.example.com/api/tf/acme/prod/lock"'
    )
  })

  it('uses POST and DELETE, never the LOCK and UNLOCK defaults', () => {
    // The regression this guards is silent: a block with the default verbs
    // works locally and 405s behind an edge proxy that drops them.
    const snippet = backendSnippet(base)
    expect(snippet).toContain('lock_method    = "POST"')
    expect(snippet).toContain('unlock_method  = "DELETE"')
    expect(snippet).not.toMatch(/=\s*"(LOCK|UNLOCK)"/)
  })

  it('names the username Terraform requires', () => {
    expect(backendSnippet(base)).toContain('username       = "statesman"')
  })

  it('leaves the password out unless one is given', () => {
    expect(backendSnippet(base)).not.toContain('password')
    expect(backendSnippet({ ...base, password: 'sm_abc' })).toContain('password       = "sm_abc"')
  })

  it('is a complete, balanced block', () => {
    const snippet = backendSnippet(base)
    expect(snippet.startsWith('terraform {\n  backend "http" {')).toBe(true)
    expect(snippet.endsWith('  }\n}')).toBe(true)
  })
})
