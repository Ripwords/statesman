import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { resolveTestDatabaseUrl } from '../tests/test-database'

const run = promisify(execFile)

if (existsSync('.env')) process.loadEnvFile('.env')

/**
 * Creates and migrates the database the suites run against.
 *
 * `pnpm test` calls this rather than relying on a `pretest` hook: pnpm ships
 * with `enable-pre-post-scripts=false`, so a `pretest` script would be silently
 * skipped and the first run would fail against a database nothing had created.
 */
async function main(): Promise<void> {
  const url = resolveTestDatabaseUrl(process.env)
  const parsed = new URL(url)
  const name = parsed.pathname.replace(/^\//, '')

  // CREATE DATABASE cannot run inside a transaction or against the database it
  // is creating, so this connects to the always-present `postgres` one.
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const client = new Client({ connectionString: admin.toString() })
  await client.connect()
  try {
    const existing = await client.query('select 1 from pg_database where datname = $1', [name])
    if (existing.rowCount === 0) {
      // The name comes from our own connection string, never from a request,
      // but an identifier cannot be a bind parameter so it is quoted anyway.
      await client.query(`create database "${name.replaceAll('"', '""')}"`)
      console.log(`Created test database: ${name}`)
    }
  } finally {
    await client.end()
  }

  // process.loadEnvFile does not overwrite variables already set, and neither
  // does drizzle.config.ts, so this override survives into the child.
  await run('pnpm', ['exec', 'drizzle-kit', 'migrate'], {
    env: { ...process.env, DATABASE_URL: url }
  })
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
