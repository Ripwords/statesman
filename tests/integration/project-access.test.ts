import { isApiError, testEvent } from '../ui/nitro-globals'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { describe, it, expect, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { projectAccess, projectMember } from '../../server/db/schema'
import {
  provisionUser,
  signInHeaders,
  setRole,
  resetDb,
  seedProject,
  grantProjectRole
} from '../protocol/helpers'
import {
  requireProjectPermission,
  effectiveRole,
  effectiveRoleOfUser,
  ensureAccessRecord
} from '../../server/utils/project-access'
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

const ORG = 'project-access'
const PASSWORD = 'correct horse battery staple'
let projectId: string
const headers: Record<string, Record<string, string>> = {}

beforeAll(async () => {
  await resetDb(ORG)
  projectId = await seedProject(ORG, 'p')
  const stamp = Date.now()
  for (const name of ['admin', 'owner', 'editor', 'viewer', 'stranger'] as const) {
    const u = await provisionUser(`pa-${name}-${stamp}@example.com`, PASSWORD)
    await setRole(u.id, name === 'admin' ? 'admin' : 'member')
    if (name === 'owner' || name === 'editor' || name === 'viewer') {
      await grantProjectRole(projectId, u.id, name)
    }
    headers[name] = Object.fromEntries((await signInHeaders(u.email, PASSWORD)).entries())
  }
})

async function refusal(call: Promise<unknown>): Promise<{ status?: number; message?: string }> {
  try {
    await call
    return {}
  } catch (error) {
    return isApiError(error) ? { status: error.statusCode, message: error.statusMessage } : {}
  }
}

describe('requireProjectPermission', () => {
  it('answers a stranger exactly as it answers an unknown project', async () => {
    const stranger = await refusal(
      requireProjectPermission(testEvent({ headers: headers.stranger }), projectId, 'project:read')
    )
    const unknown = await refusal(
      requireProjectPermission(
        testEvent({ headers: headers.stranger }),
        'no-such-project',
        'project:read'
      )
    )
    expect(stranger).toEqual({
      status: 404,
      message: 'Unknown project. Check the project id and try again.'
    })
    expect(unknown).toEqual(stranger)
  })

  it('answers 403 naming the role needed when the role is too low', async () => {
    expect(
      await refusal(
        requireProjectPermission(
          testEvent({ headers: headers.viewer }),
          projectId,
          'variable:write'
        )
      )
    ).toEqual({ status: 403, message: 'Needs editor access to this project. Ask a project owner.' })
  })

  it('lets an admin through with no membership row', async () => {
    const p = await requireProjectPermission(
      testEvent({ headers: headers.admin }),
      projectId,
      'member:manage'
    )
    expect(p.projectRole).toBe('admin')
  })

  it('returns the member role', async () => {
    const p = await requireProjectPermission(
      testEvent({ headers: headers.editor }),
      projectId,
      'variable:write'
    )
    expect(p.projectRole).toBe('editor')
  })

  it('answers 401 with no session, before anything else', async () => {
    expect(
      (await refusal(requireProjectPermission(testEvent(), 'anything', 'project:read'))).status
    ).toBe(401)
  })
})

describe('effectiveRoleOfUser', () => {
  it('is null for a user id that does not exist', async () => {
    expect(await effectiveRoleOfUser('nobody', projectId)).toBeNull()
  })
})

describe('ensureAccessRecord', () => {
  it('recreates a missing access record and is idempotent', async () => {
    const p = await seedProject(ORG, 'healed')
    await db().delete(projectAccess).where(eq(projectAccess.id, p))
    await ensureAccessRecord(p, 'healed')
    await ensureAccessRecord(p, 'healed')
    expect(await db().select().from(projectAccess).where(eq(projectAccess.id, p))).toHaveLength(1)
  })
})

describe('guard edge cases', () => {
  it('treats an unrecognised role string as no access', async () => {
    const u = await provisionUser(`pa-odd-${Date.now()}@example.com`, PASSWORD)
    await db()
      .insert(projectMember)
      .values({ id: ulid(), organizationId: projectId, userId: u.id, role: 'superuser' })
    const odd = Object.fromEntries((await signInHeaders(u.email, PASSWORD)).entries())
    expect(await effectiveRole({ userId: u.id, role: 'member' }, projectId)).toBeNull()
    expect(
      await refusal(
        requireProjectPermission(testEvent({ headers: odd }), projectId, 'project:read')
      )
    ).toEqual({ status: 404, message: 'Unknown project. Check the project id and try again.' })
  })

  it('answers an admin on an unknown project exactly as it answers a stranger', async () => {
    const stranger = await refusal(
      requireProjectPermission(
        testEvent({ headers: headers.stranger }),
        'no-such-project',
        'project:read'
      )
    )
    const admin = await refusal(
      requireProjectPermission(
        testEvent({ headers: headers.admin }),
        'no-such-project',
        'project:read'
      )
    )
    expect(admin).toEqual({
      status: 404,
      message: 'Unknown project. Check the project id and try again.'
    })
    expect(admin).toEqual(stranger)
  })

  it('lets an admin through on a real project whose access row is missing', async () => {
    const p = await seedProject(ORG, 'no-access-row')
    await db().delete(projectAccess).where(eq(projectAccess.id, p))
    const principal = await requireProjectPermission(
      testEvent({ headers: headers.admin }),
      p,
      'environment:create'
    )
    expect(principal.projectRole).toBe('admin')
  })
})
