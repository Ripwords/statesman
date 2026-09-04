import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { runHealthChecks } from '../../server/utils/health'
import { store } from '../../server/storage'
import { LocalStore } from '../../server/storage/local'
import type { StateStore } from '../../server/storage/types'

describe('health checks', () => {
  it('passes with a correctly configured environment', async () => {
    const result = await runHealthChecks()
    expect(result.checks.map((c) => c.name).sort())
      .toEqual(['database', 'encryption', 'migrations', 'storage'])
    expect(result.ok, JSON.stringify(result.checks)).toBe(true)
  })

  it('times every check', async () => {
    const result = await runHealthChecks()
    for (const check of result.checks) expect(check.ms).toBeGreaterThanOrEqual(0)
  })

  it('leaves no probe object behind', async () => {
    await runHealthChecks()
    expect(await store().list('.statesman-healthcheck/')).toHaveLength(0)
  })

  it('reports a failing check by name without leaking configuration', async () => {
    // Rooting the store at an existing FILE makes the probe's mkdir fail with
    // ENOTDIR, and Node puts the absolute path in the message — so the
    // redaction assertions below have something real to strip. Using the repo's
    // own package.json means the path genuinely starts with the checkout
    // directory, which on this machine is under /Users/.
    const unwritableRoot = join(process.cwd(), 'package.json')
    const result = await runHealthChecks({ store: new LocalStore(unwritableRoot) })
    const storage = result.checks.find((c) => c.name === 'storage')

    expect(result.ok).toBe(false)
    expect(storage?.ok).toBe(false)
    expect(storage?.detail ?? '').not.toMatch(/secret|password|key|\/Users\//i)
    // Machine-independent and strictly stronger than the regex above: the
    // configured root must not appear in an unauthenticated response.
    expect(storage?.detail ?? '').not.toContain(unwritableRoot)
    expect(storage?.detail ?? '').not.toContain(process.cwd())

    // The other three checks still ran and still passed.
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['storage'])
  })
})

/** Records every call so a test can prove a probe was skipped, not merely quiet. */
class RecordingStore implements StateStore {
  readonly calls: string[] = []
  async put(key: string): Promise<void> { this.calls.push(`put:${key}`) }
  async get(key: string): Promise<Uint8Array | null> { this.calls.push(`get:${key}`); return null }
  async delete(key: string): Promise<void> { this.calls.push(`delete:${key}`) }
  async list(prefix: string): Promise<string[]> { this.calls.push(`list:${prefix}`); return [] }
}

describe('assertHealthy', () => {
  const original = { ...process.env }

  afterEach(() => {
    process.env = { ...original }
    vi.resetModules()
  })

  // env() caches on first call, so each branch needs a fresh module graph.
  async function loadWith(overrides: NodeJS.ProcessEnv) {
    vi.resetModules()
    Object.assign(process.env, overrides)
    return import('../../server/utils/health')
  }

  it('skips every probe on serverless without touching any dependency', async () => {
    // STORAGE_DRIVER must be s3 here: loadEnv rejects local storage on a
    // serverless platform outright, which is a different guard entirely.
    const { assertHealthy } = await loadWith({
      VERCEL: '1',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'probe-bucket'
    })
    const recorder = new RecordingStore()

    await expect(assertHealthy({ store: recorder })).resolves.toBeUndefined()

    // The assertion that matters: deleting the IS_SERVERLESS guard would make
    // runHealthChecks put/get/delete a probe object and this would fail.
    expect(recorder.calls).toEqual([])
  })

  it('rejects on a long-running server and names the failing check', async () => {
    const { assertHealthy } = await loadWith({ VERCEL: '', AWS_LAMBDA_FUNCTION_NAME: '' })
    const unwritableRoot = join(process.cwd(), 'package.json')

    await expect(assertHealthy({ store: new LocalStore(unwritableRoot) }))
      .rejects.toThrow(/storage/)
  })

  it('does not leak configuration in the thrown startup message', async () => {
    const { assertHealthy } = await loadWith({ VERCEL: '', AWS_LAMBDA_FUNCTION_NAME: '' })
    const unwritableRoot = join(process.cwd(), 'package.json')

    // This message is logged at boot, so it gets the same treatment.
    const error = await assertHealthy({ store: new LocalStore(unwritableRoot) })
      .then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(unwritableRoot)
  })

  it('resolves when every probe passes', async () => {
    const { assertHealthy } = await loadWith({ VERCEL: '', AWS_LAMBDA_FUNCTION_NAME: '' })
    await expect(assertHealthy()).resolves.toBeUndefined()
  })
})
