// Must stay first: stands up the Nitro globals (createError) before sync.ts loads.
import { testEvent } from '../ui/nitro-globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { githubInstallation } from '../../server/db/schema'
import { resetDb, seedProject } from '../protocol/helpers'
import { GitHubClient } from '../../server/github/client'
import { createHclToolkit, type HclToolkit } from '../../server/hcl/toolkit'
import { createEnvironment } from '../../server/services/variables'
import {
  recordInstallation,
  removeInstallation,
  linkRepository,
  unlinkRepository,
  linkSummary,
  normaliseDirectory,
  syncEnvironment,
  linksForPush,
  markRepositoriesRevoked
} from '../../server/services/sync'

void testEvent

const ORG = 'sync-service'
// Installation ids are global, so each suite picks its own range.
const INSTALLATION = 9_100_001
let envId: string

beforeEach(async () => {
  await resetDb(ORG)
  await db().delete(githubInstallation).where(eq(githubInstallation.installationId, INSTALLATION))
  const projectId = await seedProject(ORG, 'p')
  envId = (await createEnvironment(projectId, 'dev')).id
  await recordInstallation(INSTALLATION, 'acme')
})

const link = (over: Partial<Parameters<typeof linkRepository>[0]> = {}) =>
  linkRepository({
    environmentId: envId,
    installationId: INSTALLATION,
    repoId: 55,
    repoFullName: 'acme/infra',
    ref: 'main',
    directory: 'envs/dev',
    ...over
  })

describe('normaliseDirectory', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['/envs/dev/', 'envs/dev'],
    ['envs//dev', 'envs/dev']
  ])('%j -> %j', (input, output) => {
    expect(normaliseDirectory(input)).toBe(output)
  })
  it('refuses parent segments', () => {
    expect(() => normaliseDirectory('envs/../secrets')).toThrow(
      expect.objectContaining({ statusCode: 400 })
    )
  })
})

describe('links', () => {
  it('records an installation idempotently', async () => {
    await recordInstallation(INSTALLATION, 'acme')
    const rows = await db()
      .select()
      .from(githubInstallation)
      .where(eq(githubInstallation.installationId, INSTALLATION))
    expect(rows).toHaveLength(1)
  })

  it('links, relinks, and summarises without a sync', async () => {
    await link()
    await link({ ref: 'release' })
    const found = await linkSummary(envId)
    expect(found?.summary).toMatchObject({
      repoFullName: 'acme/infra',
      ref: 'release',
      lastSyncedAt: null
    })
    expect(found?.declared).toBeNull()
  })

  it('unlinks', async () => {
    await link()
    expect(await unlinkRepository(envId)).toBe(true)
    expect(await linkSummary(envId)).toBeNull()
  })

  it('drops links when the installation is removed', async () => {
    await link()
    await removeInstallation(INSTALLATION)
    expect(await linkSummary(envId)).toBeNull()
  })
})

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString()
let hcl: HclToolkit

beforeAll(async () => {
  hcl = await createHclToolkit(async (name) => readFileSync(join('server/assets/wasm', name)))
})

/** A fake GitHub holding one repo whose files can be swapped between syncs. */
function fakeGitHub(files: Record<string, string> | 'gone', onList?: () => Promise<void>) {
  const impl: typeof fetch = async (input) => {
    const url = new URL(String(input))
    const p = url.pathname
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (p.endsWith('/access_tokens'))
      return json({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201)
    if (p === '/repos/acme/infra/commits/main') return new Response('sha-1')
    if (p === '/repos/acme/infra/contents/envs/dev') {
      await onList?.()
      if (files === 'gone') return json({ message: 'Not Found' }, 404)
      return json(
        Object.keys(files).map((name) => ({ type: 'file', name, path: `envs/dev/${name}` }))
      )
    }
    const name = p.replace('/repos/acme/infra/contents/envs/dev/', '')
    if (files !== 'gone' && name in files) return new Response(files[name])
    return json({ message: 'Not Found' }, 404)
  }
  return new GitHubClient({ id: '1', slug: 's', privateKey: pem, webhookSecret: 'w' }, impl)
}

describe('syncEnvironment', () => {
  it('stores the declared set and the sha', async () => {
    await link()
    const result = await syncEnvironment(envId, {
      client: fakeGitHub({
        'variables.tf': 'variable "a" {}\nvariable "b" { default = 1 }\n',
        'readme.md': ''
      }),
      hcl
    })
    expect(result).toEqual({ ok: true, count: 2, sha: 'sha-1' })
    const found = await linkSummary(envId)
    expect(found?.declared?.map((d) => d.name)).toEqual(['a', 'b'])
    expect(found?.summary).toMatchObject({ lastSyncedSha: 'sha-1', lastSyncError: null })
  })

  it('keeps the previous declared set when the directory is gone', async () => {
    await link()
    await syncEnvironment(envId, {
      client: fakeGitHub({ 'variables.tf': 'variable "a" {}\n' }),
      hcl
    })
    const result = await syncEnvironment(envId, { client: fakeGitHub('gone'), hcl })
    expect(result.ok).toBe(false)
    const found = await linkSummary(envId)
    expect(found?.declared?.map((d) => d.name)).toEqual(['a'])
    expect(found?.summary.lastSyncError).toMatch(/Not Found/)
  })

  it('records an error for a directory with no .tf files, keeping the previous set', async () => {
    await link()
    await syncEnvironment(envId, {
      client: fakeGitHub({ 'variables.tf': 'variable "a" {}\n' }),
      hcl
    })
    const result = await syncEnvironment(envId, { client: fakeGitHub({ 'README.md': '' }), hcl })
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('No .tf files in envs/dev')
    })
    expect((await linkSummary(envId))?.declared?.map((d) => d.name)).toEqual(['a'])
  })

  it('fails the whole sync on one unparsable file', async () => {
    await link()
    const result = await syncEnvironment(envId, {
      client: fakeGitHub({
        'good.tf': 'variable "a" {}\n',
        'bad.tf': 'variable "b" {\n  type =\n'
      }),
      hcl
    })
    expect(result).toEqual({ ok: false, error: expect.stringContaining('envs/dev/bad.tf') })
    expect((await linkSummary(envId))?.declared).toBeNull()
  })

  it('fails the whole sync when two files declare the same variable', async () => {
    await link()
    await syncEnvironment(envId, { client: fakeGitHub({ 'one.tf': 'variable "old" {}\n' }), hcl })
    const result = await syncEnvironment(envId, {
      client: fakeGitHub({ 'a.tf': 'variable "region" {}\n', 'b.tf': 'variable "region" {}\n' }),
      hcl
    })
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/"region".*envs\/dev\/a\.tf.*envs\/dev\/b\.tf/)
    })
    expect((await linkSummary(envId))?.declared?.map((d) => d.name)).toEqual(['old'])
  })

  it('names the file once when one file declares a variable twice', async () => {
    await link()
    const result = await syncEnvironment(envId, {
      client: fakeGitHub({ 'main.tf': 'variable "region" {}\nvariable "region" {}\n' }),
      hcl
    })
    expect(result).toEqual({
      ok: false,
      error: 'variable "region" is declared twice in envs/dev/main.tf'
    })
  })

  it('does not write onto a link that changed mid-sync', async () => {
    await link()
    const relinking = fakeGitHub({ 'variables.tf': 'variable "a" {}\n' }, async () => {
      await link({ repoId: 77, repoFullName: 'acme/other' })
    })
    const result = await syncEnvironment(envId, { client: relinking, hcl })
    expect(result).toEqual({ ok: false, error: 'The repository link changed during the sync.' })
    const found = await linkSummary(envId)
    expect(found?.summary).toMatchObject({
      repoFullName: 'acme/other',
      lastSyncedSha: null,
      lastSyncError: null
    })
    expect(found?.declared).toBeNull()
  })

  it('refuses an environment with no link', async () => {
    const result = await syncEnvironment(envId, { client: fakeGitHub({}), hcl })
    expect(result).toEqual({ ok: false, error: 'This environment is not linked to a repository.' })
  })
})

describe('push routing', () => {
  it('finds links by repo id and branch', async () => {
    await link()
    expect(await linksForPush(55, 'main')).toContain(envId)
    expect(await linksForPush(55, 'other')).not.toContain(envId)
  })

  it('marks revoked repositories', async () => {
    await link()
    await markRepositoriesRevoked(INSTALLATION, [55])
    expect((await linkSummary(envId))?.summary.lastSyncError).toMatch(/no longer has access/)
  })
})
