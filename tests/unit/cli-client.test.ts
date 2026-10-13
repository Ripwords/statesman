import { describe, it, expect } from 'vitest'
import { fetchCheckout } from '../../cli/src/client'
import { CliError } from '../../cli/src/errors'

const respond = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
const args = { server: 'https://s.example.com', project: 'acme/p', env: 'client', token: 't' }

async function failure(fetchImpl: typeof fetch): Promise<CliError> {
  try {
    await fetchCheckout({ ...args, fetchImpl })
  } catch (e) {
    if (e instanceof CliError) return e
    throw e
  }
  throw new Error('expected a CliError')
}

describe('fetchCheckout', () => {
  it('sends Basic auth to the checkout path and returns the body', async () => {
    let seen: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input, init)
      return new Response(JSON.stringify({ variables: { a: 1 }, backend: null }))
    }) as typeof fetch
    expect(await fetchCheckout({ ...args, fetchImpl })).toEqual({
      variables: { a: 1 },
      backend: null
    })
    expect(seen?.url).toBe('https://s.example.com/api/checkout/acme/p/client')
    expect(seen?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('statesman:t').toString('base64')}`
    )
  })

  it.each([
    [401, /rejected STATESMAN_TOKEN/],
    [403, /cannot read variables of acme\/p/],
    [404, /environment "client" does not exist in acme\/p.*Variables tab/],
    [500, /statesman answered 500/]
  ])('maps %i to an exit-2 error with the fix', async (status, message) => {
    const e = await failure(respond(status))
    expect(e.exitCode).toBe(2)
    expect(e.message).toMatch(message)
  })

  it('maps a network failure to exit 2 naming the server', async () => {
    const e = await failure((async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    expect(e.exitCode).toBe(2)
    expect(e.message).toContain('https://s.example.com')
  })

  it('refuses a body that is not a checkout response without echoing it', async () => {
    const e = await failure(respond(200, { nope: 'leaky-body' }))
    expect(e.exitCode).toBe(2)
    expect(e.message).not.toContain('leaky-body')
  })
})
