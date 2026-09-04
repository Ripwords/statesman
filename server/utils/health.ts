import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { store } from '../storage'
import type { StateStore } from '../storage/types'
import { seal, open } from './crypto'
import { env } from './env'

export type CheckName = 'encryption' | 'database' | 'migrations' | 'storage'
export type CheckResult = { name: CheckName; ok: boolean; detail?: string; ms: number }
export type HealthReport = { ok: boolean; checks: CheckResult[] }

/** Overrides exist so a failure path can be exercised; production passes none. */
export type HealthDeps = { store?: StateStore }

const PROBE_PREFIX = '.statesman-healthcheck/'
const MAX_DETAIL = 120

// /api/health is unauthenticated, so a failure detail must never carry a
// connection string, S3 endpoint, filesystem path or key material. Redaction
// happens BEFORE truncation: slicing first can cut a connection string in half
// and leave the credentials in the surviving fragment.
export function redactForHealth(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split('\n')[0] ?? '')
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<redacted-url>')
    .replace(/(?:[A-Za-z]:)?[\\/](?:[\w.@~-]+[\\/])+[\w.@~-]*/g, '<redacted-path>')
    .slice(0, MAX_DETAIL)
}

async function timed(name: CheckName, fn: () => Promise<void>): Promise<CheckResult> {
  const started = Date.now()
  try {
    await fn()
    return { name, ok: true, ms: Date.now() - started }
  } catch (error) {
    return { name, ok: false, detail: redactForHealth(error), ms: Date.now() - started }
  }
}

export async function runHealthChecks(deps: HealthDeps = {}): Promise<HealthReport> {
  const blobs = deps.store ?? store()

  const checks = [
    await timed('encryption', async () => {
      const probe = randomBytes(32)
      const key = env().ENCRYPTION_KEY
      if (!open(key, seal(key, probe)).equals(probe)) {
        throw new Error('encryption round-trip mismatch')
      }
    }),
    await timed('database', async () => {
      await db().execute(sql`select 1`)
    }),
    await timed('migrations', async () => {
      // Both drivers return { rows }: node-postgres gives pg.QueryResult<T> and
      // neon-http gives NeonHttpQueryResult<T>, which is FullQueryResults with
      // rows narrowed to T[]. No shape juggling is needed.
      const result = await db().execute<{ present: boolean }>(
        sql`select to_regclass('public.organization') is not null as present`
      )
      if (!result.rows[0]?.present) throw new Error('migrations have not been applied')
    }),
    await timed('storage', async () => {
      // Put, get AND delete. A read-only probe passes for credentials that can
      // list but not write — the exact failure that surfaces on the first
      // `terraform apply` rather than at deploy time.
      const key = `${PROBE_PREFIX}${ulid()}`
      const payload = randomBytes(16)
      await blobs.put(key, payload)
      try {
        const readBack = await blobs.get(key)
        if (!readBack || !Buffer.from(readBack).equals(payload)) {
          throw new Error('storage round-trip mismatch')
        }
      } finally {
        // Always reclaim the probe, including when the read-back failed.
        await blobs.delete(key)
      }
    })
  ]

  return { ok: checks.every((c) => c.ok), checks }
}

export async function assertHealthy(): Promise<void> {
  // Serverless functions cold-start constantly and Neon scales to zero. Probing
  // the database on every cold start would add latency to every request path
  // and turn a brief upstream blip into a hard outage. /api/health still runs
  // the same probes on demand, so the information stays available without
  // gating startup.
  if (env().IS_SERVERLESS) return

  const result = await runHealthChecks()
  if (result.ok) return

  const failed = result.checks.filter((c) => !c.ok)
  throw new Error(
    `statesman startup checks failed:\n${failed.map((c) => `  - ${c.name}: ${c.detail}`).join('\n')}`
  )
}
