import { createSign } from 'node:crypto'
import { z } from 'zod'
import { env, type GitHubAppConfig } from '../utils/env'

const API = 'https://api.github.com'

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/** Backdated a minute for clock skew; GitHub caps the lifetime at ten. */
export function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const iat = Math.floor(nowMs / 1000) - 60
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat, exp: iat + 540, iss: appId })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')
  return `${unsigned}.${signature}`
}

const UNEXPECTED = 'GitHub sent an unexpected response.'

/** Only the fields statesman reads; GitHub's answers carry many more. */
const installationBody = z.object({
  id: z.number(),
  account: z.object({ login: z.string().min(1) })
})
const tokenBody = z.object({ token: z.string().min(1), expires_at: z.string() })
const repositoriesBody = z.object({
  total_count: z.number(),
  repositories: z.array(
    z.object({ id: z.number(), full_name: z.string(), default_branch: z.string() })
  )
})
const entry = z.object({ type: z.string(), name: z.string(), path: z.string() })
const contentsBody = z.union([z.array(entry), z.object({ type: z.string() })])

/** A body that is not JSON, or not the shape we read, is GitHub's fault, not a 500 of ours. */
async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new GitHubError(UNEXPECTED, 502)
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new GitHubError(UNEXPECTED, 502)
  return parsed.data
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    throw new GitHubError(UNEXPECTED, 502)
  }
}

/**
 * Just the six calls statesman makes, over an injectable fetch so tests need
 * no HTTP mocking library (variables spec §9). Installation tokens live in
 * memory only and are refreshed five minutes before they expire, or at once
 * when GitHub rejects one. Every failure, a network one or a malformed answer
 * included, is a GitHubError, so a sync records it rather than throwing.
 */
export class GitHubClient {
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>()

  constructor(
    private readonly app: GitHubAppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 10_000
  ) {}

  private async call(
    path: string,
    auth: string,
    init: { method?: string; accept?: string } = {}
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(`${API}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: auth,
          accept: init.accept ?? 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'statesman'
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError')
        throw new GitHubError('GitHub did not answer in time.', 504)
      throw new GitHubError('Could not reach GitHub.', 502)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let message = text
      try {
        const parsed: { message?: unknown } = JSON.parse(text)
        if (typeof parsed.message === 'string') message = parsed.message
      } catch {
        // Not JSON; keep the text.
      }
      throw new GitHubError(`GitHub ${response.status}: ${message}`, response.status)
    }
    return response
  }

  private asApp(path: string, method?: string) {
    let jwt: string
    try {
      jwt = appJwt(this.app.id, this.app.privateKey, this.now())
    } catch {
      throw new GitHubError(
        'The GitHub App private key could not sign a request. Check GITHUB_APP_PRIVATE_KEY.',
        500
      )
    }
    return this.call(path, `Bearer ${jwt}`, { method })
  }

  private async installationAuth(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId)
    if (cached && cached.expiresAt - 300_000 > this.now()) return `token ${cached.token}`
    const response = await this.asApp(`/app/installations/${installationId}/access_tokens`, 'POST')
    const body = await readJson(response, tokenBody)
    this.tokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) })
    return `token ${body.token}`
  }

  private async asInstallation(installationId: number, path: string, accept?: string) {
    try {
      return await this.call(path, await this.installationAuth(installationId), { accept })
    } catch (error) {
      // A revoked or rotated token: the next call mints a fresh one instead of
      // reusing it until its expiry.
      if (error instanceof GitHubError && error.status === 401) this.tokens.delete(installationId)
      throw error
    }
  }

  async getInstallation(id: number): Promise<{ id: number; accountLogin: string }> {
    const body = await readJson(await this.asApp(`/app/installations/${id}`), installationBody)
    return { id: body.id, accountLogin: body.account.login }
  }

  async listRepositories(
    installationId: number
  ): Promise<Array<{ id: number; fullName: string; defaultBranch: string }>> {
    const out: Array<{ id: number; fullName: string; defaultBranch: string }> = []
    for (let page = 1; ; page++) {
      const response = await this.asInstallation(
        installationId,
        `/installation/repositories?per_page=100&page=${page}`
      )
      const body = await readJson(response, repositoriesBody)
      out.push(
        ...body.repositories.map((r) => ({
          id: r.id,
          fullName: r.full_name,
          defaultBranch: r.default_branch
        }))
      )
      if (out.length >= body.total_count || body.repositories.length === 0) return out
    }
  }

  async resolveCommit(installationId: number, fullName: string, ref: string): Promise<string> {
    const response = await this.asInstallation(
      installationId,
      `/repos/${fullName}/commits/${encodeURIComponent(ref)}`,
      'application/vnd.github.sha'
    )
    return (await readText(response)).trim()
  }

  /** `.tf` files directly in `directory` at `sha`. Subdirectories are child modules and are not inputs. */
  async listTfFiles(
    installationId: number,
    fullName: string,
    directory: string,
    sha: string
  ): Promise<string[]> {
    const path = directory.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    const response = await this.asInstallation(
      installationId,
      `/repos/${fullName}/contents/${path}?ref=${sha}`
    )
    const body = await readJson(response, contentsBody)
    if (!Array.isArray(body))
      throw new GitHubError(`${directory || '/'} is a file, not a directory`, 400)
    return body.filter((e) => e.type === 'file' && e.name.endsWith('.tf')).map((e) => e.path)
  }

  async readFile(
    installationId: number,
    fullName: string,
    path: string,
    sha: string
  ): Promise<string> {
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const response = await this.asInstallation(
      installationId,
      `/repos/${fullName}/contents/${encoded}?ref=${sha}`,
      'application/vnd.github.raw'
    )
    return readText(response)
  }
}

let client: GitHubClient | null | undefined

export function github(): GitHubClient | null {
  if (client === undefined) {
    const config = env().GITHUB_APP
    client = config ? new GitHubClient(config) : null
  }
  return client
}
