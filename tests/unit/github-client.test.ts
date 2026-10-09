import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { GitHubClient, GitHubError, appJwt } from '../../server/github/client'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const app = { id: '42', slug: 's', privateKey: pem, webhookSecret: 'w' }

type Call = { method: string; url: string; auth: string | null; accept: string | null }

/** Routes `METHOD /path` to a JSON or text body; anything unrouted is a 404. */
function fakeFetch(routes: Record<string, { status?: number; json?: unknown; text?: string }>) {
  const calls: Call[] = []
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    calls.push({
      method,
      url: url.pathname + url.search,
      auth: headers.get('authorization'),
      accept: headers.get('accept')
    })
    const route = routes[`${method} ${url.pathname}`]
    if (!route) return new Response('{"message":"Not Found"}', { status: 404 })
    const body = route.text ?? JSON.stringify(route.json)
    return new Response(body, { status: route.status ?? 200 })
  }
  return { impl, calls }
}

const tokenRoute = {
  'POST /app/installations/7/access_tokens': {
    status: 201,
    json: { token: 'ghs_x', expires_at: new Date(Date.now() + 3_600_000).toISOString() }
  }
}

describe('appJwt', () => {
  it('is an RS256 JWT issued by the app, backdated 60s, valid under 10 minutes', () => {
    const jwt = appJwt('42', pem, 1_000_000_000_000)
    const [h, p, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h ?? '', 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT'
    })
    const payload = JSON.parse(Buffer.from(p ?? '', 'base64url').toString())
    expect(payload).toEqual({ iss: '42', iat: 1_000_000_000 - 60, exp: 1_000_000_000 - 60 + 540 })
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(s ?? '', 'base64url'))
    expect(ok).toBe(true)
  })
})

describe('GitHubClient', () => {
  it('confirms an installation with the app JWT', async () => {
    const { impl, calls } = fakeFetch({
      'GET /app/installations/7': { json: { id: 7, account: { login: 'acme' } } }
    })
    const client = new GitHubClient(app, impl)
    expect(await client.getInstallation(7)).toEqual({ id: 7, accountLogin: 'acme' })
    expect(calls[0]?.auth).toMatch(/^Bearer ey/)
  })

  it('caches the installation token across calls', async () => {
    const { impl, calls } = fakeFetch({
      ...tokenRoute,
      'GET /installation/repositories': {
        json: {
          total_count: 1,
          repositories: [{ id: 1, full_name: 'acme/infra', default_branch: 'main' }]
        }
      }
    })
    const client = new GitHubClient(app, impl)
    await client.listRepositories(7)
    const repos = await client.listRepositories(7)
    expect(repos).toEqual([{ id: 1, fullName: 'acme/infra', defaultBranch: 'main' }])
    expect(calls.filter((c) => c.url.includes('access_tokens'))).toHaveLength(1)
    expect(calls.at(-1)?.auth).toBe('token ghs_x')
  })

  it('lists only .tf files directly in the directory', async () => {
    const { impl } = fakeFetch({
      ...tokenRoute,
      'GET /repos/acme/infra/contents/envs/prod': {
        json: [
          { type: 'file', name: 'main.tf', path: 'envs/prod/main.tf' },
          { type: 'file', name: 'prod.tfvars', path: 'envs/prod/prod.tfvars' },
          { type: 'dir', name: 'modules', path: 'envs/prod/modules' },
          { type: 'file', name: 'variables.tf', path: 'envs/prod/variables.tf' }
        ]
      }
    })
    const client = new GitHubClient(app, impl)
    expect(await client.listTfFiles(7, 'acme/infra', 'envs/prod', 'abc')).toEqual([
      'envs/prod/main.tf',
      'envs/prod/variables.tf'
    ])
  })

  it('treats the repository root as the empty directory', async () => {
    const { impl, calls } = fakeFetch({
      ...tokenRoute,
      'GET /repos/acme/infra/contents/': { json: [] }
    })
    await new GitHubClient(app, impl).listTfFiles(7, 'acme/infra', '', 'abc')
    expect(calls.at(-1)?.url).toBe('/repos/acme/infra/contents/?ref=abc')
  })

  it('reports a path that is a file, not a directory', async () => {
    const { impl } = fakeFetch({
      ...tokenRoute,
      'GET /repos/acme/infra/contents/main.tf': { json: { type: 'file' } }
    })
    await expect(
      new GitHubClient(app, impl).listTfFiles(7, 'acme/infra', 'main.tf', 'abc')
    ).rejects.toThrow(/is a file, not a directory/)
  })

  it('reads raw file content', async () => {
    const { impl, calls } = fakeFetch({
      ...tokenRoute,
      'GET /repos/acme/infra/contents/main.tf': { text: 'variable "a" {}' }
    })
    expect(await new GitHubClient(app, impl).readFile(7, 'acme/infra', 'main.tf', 'abc')).toBe(
      'variable "a" {}'
    )
    expect(calls.at(-1)?.accept).toBe('application/vnd.github.raw')
  })

  it('resolves a branch to a commit sha', async () => {
    const { impl } = fakeFetch({
      ...tokenRoute,
      'GET /repos/acme/infra/commits/main': { text: 'deadbeef' }
    })
    expect(await new GitHubClient(app, impl).resolveCommit(7, 'acme/infra', 'main')).toBe(
      'deadbeef'
    )
  })

  it('raises GitHubError with GitHub’s message and status', async () => {
    const { impl } = fakeFetch(tokenRoute)
    const error = await new GitHubClient(app, impl)
      .resolveCommit(7, 'acme/infra', 'nope')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitHubError)
    expect(error).toMatchObject({ status: 404, message: expect.stringContaining('Not Found') })
  })
})
