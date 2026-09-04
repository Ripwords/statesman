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
// connection string, S3 endpoint, filesystem path, host address or key
// material.
//
// This is defence in depth, not a general secret scanner. Every failure
// currently reachable is already safe — drizzle reports "Failed query: ..." and
// keeps connection detail in .cause, and the AWS SDK puts bucket and host in
// structured fields rather than .message — but that is a property of how those
// two libraries happen to shape errors today, not a structural guarantee. These
// patterns cover the infrastructure identifiers that a future version of either
// could plausibly start putting in .message.
//
// Redaction happens BEFORE truncation: slicing first can cut a connection
// string in half and leave the credentials in the surviving fragment.
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // Connection strings and endpoints. First, so later patterns cannot match
  // fragments of a URL that has already been removed.
  [/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<redacted-url>'],
  // AWS ARNs carry the account id and resource name. Before the address
  // patterns, because an ARN is colon-dense.
  [/\barn:[^\s'"]+/gi, '<redacted-arn>'],
  // Node's own ECONNREFUSED format is a bare host:port.
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '<redacted-host>'],
  [/\[[0-9a-f:]+\](?::\d{1,5})?/gi, '<redacted-host>'],
  // Unbracketed IPv6 requires a trailing :port so that a Postgres cast
  // (`1::text`) or a timestamp (`11:42:15`) is not mistaken for an address.
  [/(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{1,4}:\d{1,5}\b/gi, '<redacted-host>'],
  // Absolute POSIX, Windows and UNC paths.
  [/(?:[A-Za-z]:)?[\\/]{1,2}(?:[\w.@~-]+[\\/])+[\w.@~-]*/g, '<redacted-path>']
]

export function redactForHealth(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n')[0] ?? ''
  const redacted = REDACTIONS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    firstLine
  )
  return redacted.slice(0, MAX_DETAIL)
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

export async function assertHealthy(deps: HealthDeps = {}): Promise<void> {
  // Serverless functions cold-start constantly and Neon scales to zero. Probing
  // the database on every cold start would add latency to every request path
  // and turn a brief upstream blip into a hard outage. /api/health still runs
  // the same probes on demand, so the information stays available without
  // gating startup.
  if (env().IS_SERVERLESS) return

  const result = await runHealthChecks(deps)
  if (result.ok) return

  const failed = result.checks.filter((c) => !c.ok)
  throw new Error(
    `statesman startup checks failed:\n${failed.map((c) => `  - ${c.name}: ${c.detail}`).join('\n')}`
  )
}
