import { testEvent } from '../ui/nitro-globals'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { describe, it, expect } from 'vitest'
import { ulid } from 'ulid'
import authCatchAll from '../../server/api/auth/[...all]'

/**
 * The backfill runs inside a transaction that is always rolled back: it is a
 * cross join over every user and every project, and other suites share this
 * database in parallel. Committing it would make their non-members viewers.
 */
describe('migration backfill', () => {
  it('makes every non-admin a viewer on every project and gives admins no rows', async () => {
    const file = readdirSync('drizzle').find((f) => f.startsWith('0003_'))
    expect(file).toBeDefined()
    const sql = readFileSync(join('drizzle', file ?? ''), 'utf8')
    const backfill = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(
        (s) =>
          s.startsWith('INSERT INTO "project_access"') ||
          s.startsWith('INSERT INTO "project_member"')
      )
    expect(backfill).toHaveLength(2)

    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      await client.query('BEGIN')
      const orgId = ulid()
      const p1 = ulid()
      const p2 = ulid()
      const admin = ulid()
      const m1 = ulid()
      const m2 = ulid()
      await client.query(`insert into organization (id, name, slug) values ($1, $1, $1)`, [orgId])
      await client.query(
        `insert into project (id, org_id, name, slug) values ($1, $3, 'a', 'a'), ($2, $3, 'b', 'b')`,
        [p1, p2, orgId]
      )
      await client.query(
        `insert into "user" (id, name, email, email_verified, role, created_at, updated_at) values
          ($1, 'a', $1 || '@t.test', false, 'admin', now(), now()),
          ($2, 'm', $2 || '@t.test', false, 'member', now(), now()),
          ($3, 'n', $3 || '@t.test', false, null, now(), now())`,
        [admin, m1, m2]
      )
      for (const statement of backfill) await client.query(statement)

      const access = await client.query(`select id from project_access where id = any($1)`, [
        [p1, p2]
      ])
      expect(access.rowCount).toBe(2)
      const members = await client.query(
        `select organization_id, user_id, role from project_member where organization_id = any($1) order by user_id`,
        [[p1, p2]]
      )
      expect(members.rows.filter((r) => r.user_id === admin)).toHaveLength(0)
      expect(members.rows.filter((r) => r.user_id === m1).map((r) => r.role)).toEqual([
        'viewer',
        'viewer'
      ])
      expect(members.rows.filter((r) => r.user_id === m2).map((r) => r.role)).toEqual([
        'viewer',
        'viewer'
      ])
    } finally {
      await client.query('ROLLBACK')
      await client.end()
    }
  })
})

describe('/api/auth/organization/*', () => {
  it('answers 404 so the plugin endpoints are not a second door', async () => {
    const event = testEvent({ headers: {} })
    Object.assign(event, { path: '/api/auth/organization/add-member', method: 'POST' })
    await expect(authCatchAll(event)).rejects.toMatchObject({ statusCode: 404 })
  })
})
