import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { runHealthChecks, redactForHealth } from '../../server/utils/health'
import { store } from '../../server/storage'
import { LocalStore } from '../../server/storage/local'

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

describe('redactForHealth', () => {
  it('strips a database connection string', () => {
    const detail = redactForHealth(
      new Error('connect ECONNREFUSED postgres://statesman:hunter2@db.internal:5432/statesman')
    )
    expect(detail).not.toContain('hunter2')
    expect(detail).not.toContain('db.internal')
    expect(detail).toContain('<redacted-url>')
  })

  it('strips an s3 endpoint', () => {
    const detail = redactForHealth(new Error('failed to reach https://minio.internal:9000/bucket'))
    expect(detail).not.toContain('minio.internal')
    expect(detail).not.toContain('bucket')
  })

  it('strips an absolute filesystem path', () => {
    const detail = redactForHealth(
      new Error("ENOTDIR: not a directory, mkdir '/Users/someone/secrets/state/probe'")
    )
    expect(detail).not.toContain('/Users/someone')
    expect(detail).not.toContain('secrets')
    expect(detail).toContain('<redacted-path>')
  })

  it('keeps only the first line and caps the length', () => {
    const detail = redactForHealth(new Error(`first line\nsecond line with detail`))
    expect(detail).toBe('first line')
    expect(redactForHealth(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(120)
  })

  it('redacts before truncating, so a long url cannot survive as a fragment', () => {
    const detail = redactForHealth(
      new Error(`${'padding '.repeat(12)}postgres://user:hunter2@host:5432/db`)
    )
    expect(detail).not.toContain('hunter2')
  })

  it('handles a non-Error throwable', () => {
    expect(redactForHealth('plain string failure')).toBe('plain string failure')
  })
})
