import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { $fetch, setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { eq } from 'drizzle-orm'
import { Client } from 'pg'
import { auth } from '../../server/utils/auth'
import { db } from '../../server/db/client'
import { auditLog, organization } from '../../server/db/schema'
import { acquireLock, currentLock } from '../../server/services/lock'
import { seedProject, resetDb, provisionUser } from './helpers'

await setup({ server: true })

let token: string
let readOnlyToken: string
let sessionCookie: string
let projectId: string
const url = '/api/tf/acme/prod'
const basicHeader = (raw: string) => ({
  authorization: `Basic ${Buffer.from(`statesman:${raw}`).toString('base64')}`
})
const authHeader = () => basicHeader(token)
const state = (serial: number) => JSON.stringify({ version: 4, serial, lineage: 'l1' })
// ofetch types `method` as a closed union of standard verbs and only
// JSON-encodes a body for PATCH/POST/PUT/DELETE, so it cannot express a LOCK
// request at all. The platform fetch can, and it is closer to what the
// Terraform CLI actually puts on the wire.
const lockVerb = (method: string, id: string): Promise<Response> =>
  fetch(absoluteUrl(`${url}/lock`), {
    method,
    headers: { ...authHeader(), 'content-type': 'application/json' },
    body: JSON.stringify({ ID: id })
  })

beforeAll(async () => {
  const email = `e2e${Date.now()}@example.com`
  // Admin: this suite drives project creation, rollback and retention.
  const user = await provisionUser(email, 'correct horse battery', 'admin')
  const key = await auth.api.createApiKey({
    body: {
      userId: user.id,
      name: 'e2e',
      permissions: { state: ['read', 'write', 'delete', 'lock'] },
      metadata: { scope: { kind: 'projects', projects: ['acme/prod'] } }
    }
  })
  token = key.key

  // Same user, same scope, but only the 'read' action — the difference between
  // 401 (bad credential) and 403 (good credential, forbidden action).
  const readOnly = await auth.api.createApiKey({
    body: {
      userId: user.id,
      name: 'e2e-readonly',
      permissions: { state: ['read'] },
      metadata: { scope: { kind: 'projects', projects: ['acme/prod'] } }
    }
  })
  readOnlyToken = readOnly.key

  // A browser session for the admin endpoints, taken over real HTTP so the
  // cookie is exactly what a dashboard would send.
  const signIn = await fetch(absoluteUrl('/api/auth/sign-in/email'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery' })
  })
  await signIn.text()
  sessionCookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
})

// This suite owns the 'acme' organization slug; see resetDb in ./helpers.
beforeEach(async () => {
  await resetDb('acme')
  projectId = await seedProject('acme', 'prod')
})

describe('terraform protocol', () => {
  it('returns 401 without credentials', async () => {
    await expect($fetch(url)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('returns 404 when no state exists yet', async () => {
    await expect($fetch(url, { headers: authHeader() })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('completes a full lock, write, read, unlock cycle', async () => {
    const lock = { ID: 'lock-1', Who: 'jj@laptop', Operation: 'OperationTypeApply' }
    await $fetch(`${url}/lock`, { method: 'POST', headers: authHeader(), body: lock })
    await $fetch(`${url}?ID=lock-1`, { method: 'POST', headers: authHeader(), body: state(1) })
    expect(await $fetch(url, { headers: authHeader() })).toMatchObject({ serial: 1 })
    await $fetch(`${url}/lock`, { method: 'DELETE', headers: authHeader(), body: lock })
  })

  it('returns 423 with holder info when the lock is held', async () => {
    await $fetch(`${url}/lock`, {
      method: 'POST',
      headers: authHeader(),
      body: { ID: 'a', Who: 'jj' }
    })
    await expect(
      $fetch(`${url}/lock`, {
        method: 'POST',
        headers: authHeader(),
        body: { ID: 'b', Who: 'other' }
      })
    ).rejects.toMatchObject({ statusCode: 423, data: expect.objectContaining({ ID: 'a' }) })
  })

  it('returns 409 for a write with the wrong lock id', async () => {
    await $fetch(`${url}/lock`, { method: 'POST', headers: authHeader(), body: { ID: 'a' } })
    await expect(
      $fetch(`${url}?ID=wrong`, { method: 'POST', headers: authHeader(), body: state(1) })
      // Spec §11: the 409 body carries the lock info too, not just the status.
    ).rejects.toMatchObject({ statusCode: 409, data: expect.objectContaining({ ID: 'a' }) })
  })

  it('allows an unlocked write', async () => {
    await $fetch(`${url}`, { method: 'POST', headers: authHeader(), body: state(1) })
    expect(await $fetch(url, { headers: authHeader() })).toMatchObject({ serial: 1 })
  })

  it('accepts the LOCK and UNLOCK verbs as well', async () => {
    const locked = await lockVerb('LOCK', 'v')
    await locked.text()
    expect(locked.status).toBe(200)

    await expect(
      $fetch(`${url}/lock`, { method: 'POST', headers: authHeader(), body: { ID: 'w' } })
    ).rejects.toMatchObject({ statusCode: 423 })

    const unlocked = await lockVerb('UNLOCK', 'v')
    await unlocked.text()
    expect(unlocked.status).toBe(200)
  })

  it('returns 403 for a project outside the token scope', async () => {
    await seedProject('acme', 'staging')
    await expect($fetch('/api/tf/acme/staging', { headers: authHeader() })).rejects.toMatchObject({
      statusCode: 403
    })
  })

  it('returns 404 for an unknown project', async () => {
    await expect($fetch('/api/tf/acme/nope', { headers: authHeader() })).rejects.toMatchObject({
      statusCode: 404
    })
  })

  it('deletes state', async () => {
    await $fetch(url, { method: 'POST', headers: authHeader(), body: state(1) })
    await $fetch(url, { method: 'DELETE', headers: authHeader() })
    await expect($fetch(url, { headers: authHeader() })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('returns 401 for a key that does not exist', async () => {
    await expect($fetch(url, { headers: basicHeader('sm_not_a_real_key') })).rejects.toMatchObject({
      statusCode: 401
    })
  })

  it('returns 403, not 401, for a valid key missing the action', async () => {
    // The credential is good — it reads fine — so a refused DELETE must not
    // read as "Invalid API key" and send an operator off rotating it.
    expect(
      await $fetch(url, { method: 'POST', headers: authHeader(), body: state(1) })
    ).toMatchObject({ ok: true })
    expect(await $fetch(url, { headers: basicHeader(readOnlyToken) })).toMatchObject({ serial: 1 })

    await expect(
      $fetch(url, { method: 'DELETE', headers: basicHeader(readOnlyToken) })
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('answers 401 before 404, so an anonymous caller cannot enumerate projects', async () => {
    const known = await $fetch(url).catch((error: unknown) => error)
    const unknown = await $fetch('/api/tf/acme/nope').catch((error: unknown) => error)
    expect(known).toMatchObject({ statusCode: 401 })
    expect(unknown).toMatchObject({ statusCode: 401 })
  })
})

describe('admin endpoints', () => {
  /**
   * This server has no CRON_SECRET, which is the default and the Docker case.
   * The scheduler's door must then not exist at all: 404, not a 401 advertising
   * an endpoint no credential could ever open. tests/protocol/retention-cron
   * covers the configured deployment.
   */
  it('has no cron retention route when CRON_SECRET is unset', async () => {
    await expect($fetch('/api/admin/retention')).rejects.toMatchObject({ statusCode: 404 })
    await expect(
      $fetch('/api/admin/retention', { headers: { authorization: 'Bearer anything' } })
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects an unauthenticated retention run', async () => {
    await expect($fetch('/api/admin/retention', { method: 'POST' })).rejects.toMatchObject({
      statusCode: 401
    })
  })

  it('rejects an unauthenticated rollback', async () => {
    await expect(
      $fetch('/api/admin/rollback', {
        method: 'POST',
        body: { projectId: 'whatever', versionId: 'whatever' }
      })
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('runs retention for a signed-in user', async () => {
    expect(
      await $fetch('/api/admin/retention', { method: 'POST', headers: { cookie: sessionCookie } })
    ).toMatchObject({ prunedVersions: 0, sweptBlobs: 0 })
  })

  it('maps an unknown version to 404', async () => {
    await expect(
      $fetch('/api/admin/rollback', {
        method: 'POST',
        headers: { cookie: sessionCookie },
        body: { projectId, versionId: 'nope' }
      })
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('maps a held lock to 409', async () => {
    await acquireLock(projectId, { ID: 'held', Who: 'someone' })
    await expect(
      $fetch('/api/admin/rollback', {
        method: 'POST',
        headers: { cookie: sessionCookie },
        body: { projectId, versionId: 'nope' }
      })
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})

/**
 * The audit row is observability, not part of the transaction. Its insert runs
 * AFTER the operation it describes has already been committed, so a failure
 * there used to turn a successful write into a 500 — and Terraform answers a
 * 500 by retrying, which writes the same state a second time and leaves a
 * duplicate version in the history.
 *
 * The failure is injected at the database rather than mocked, because the
 * handler runs in a separate server process and a mock in this one would prove
 * nothing. The constraint is narrowed to this suite's organization id so the
 * other suites sharing the database are untouched.
 */
describe('a failing audit write', () => {
  let orgId: string
  let audit: Client

  async function withAuditBlocked(body: () => Promise<void>): Promise<void> {
    // NOT VALID: enforce on new rows without validating the ones an earlier
    // step in the same test already wrote.
    await audit.query(
      `ALTER TABLE audit_log ADD CONSTRAINT audit_write_probe` +
        ` CHECK (org_id <> '${orgId}') NOT VALID`
    )
    try {
      await body()
    } finally {
      await audit.query('ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_write_probe')
    }
  }

  beforeEach(async () => {
    const rows = await db()
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, 'acme'))
    const found = rows[0]?.id
    if (!found) throw new Error('the acme organization was not seeded')
    // Interpolated into DDL, which cannot take a bind parameter. seedProject
    // ids are ULIDs; checking the alphabet keeps that true.
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(found)) {
      throw new Error(`organization id is not a ULID and must not be inlined: ${found}`)
    }
    orgId = found

    audit = new Client({ connectionString: process.env.DATABASE_URL })
    await audit.connect()
  })

  afterEach(async () => {
    await audit.end()
  })

  it('does not fail a state write that was already persisted', async () => {
    await withAuditBlocked(async () => {
      expect(
        await $fetch(url, { method: 'POST', headers: authHeader(), body: state(7) })
      ).toMatchObject({ ok: true })
      expect(await $fetch(url, { headers: authHeader() })).toMatchObject({ serial: 7 })
    })
    // Proves the injection was real: had the constraint not bitten, the write
    // would have left a state.write audit row and the assertions above would
    // pass for the wrong reason.
    const rows = await db().select().from(auditLog).where(eq(auditLog.orgId, orgId))
    expect(rows.map((r) => r.action)).not.toContain('state.write')
  })

  it('does not fail a lock that was already acquired', async () => {
    // The same shape with a worse ending: a 500 here tells Terraform the lock
    // was refused while the row is in fact held, so the next run needs a
    // force-unlock to make progress.
    await withAuditBlocked(async () => {
      expect(
        await $fetch(`${url}/lock`, {
          method: 'POST',
          headers: authHeader(),
          body: { ID: 'audit-probe', Who: 'jj@laptop' }
        })
      ).toMatchObject({ ok: true })
      expect(await currentLock(projectId)).toMatchObject({ ID: 'audit-probe' })
    })
  })

  it('does not fail a purge that already happened', async () => {
    await $fetch(url, { method: 'POST', headers: authHeader(), body: state(1) })
    await withAuditBlocked(async () => {
      expect(await $fetch(url, { method: 'DELETE', headers: authHeader() })).toMatchObject({
        ok: true
      })
    })
    await expect($fetch(url, { headers: authHeader() })).rejects.toMatchObject({ statusCode: 404 })
  })
})

/**
 * Nothing in the application used to create a project. The dashboard only read
 * them, the Terraform router answers 404 for one it does not know (spec §9), and
 * the only insert anywhere was in the seed script — so a freshly deployed
 * statesman answered 404 to every `terraform init` until an operator shelled in.
 */
describe('project creation', () => {
  // No generic: Nitro types the route from the handler, so the response shape
  // is derived from the server rather than restated here.
  const create = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    $fetch('/api/ui/projects', { method: 'POST', headers, body })

  it('rejects an anonymous create', async () => {
    await expect(create({ org: 'acme', project: 'anonymous' })).rejects.toMatchObject({
      statusCode: 401
    })
  })

  it('creates a project that then appears in the project list', async () => {
    const created = await create(
      { org: 'acme', project: 'created-here' },
      {
        cookie: sessionCookie
      }
    )
    expect(created).toMatchObject({ org: 'acme', slug: 'created-here' })

    const list = await $fetch('/api/ui/projects', { headers: { cookie: sessionCookie } })
    expect(list.map((p) => `${p.org}/${p.slug}`)).toContain('acme/created-here')
  })

  it('is immediately usable by terraform rather than still 404', async () => {
    await create({ org: 'acme', project: 'usable' }, { cookie: sessionCookie })
    // A token scoped to acme/prod cannot reach it, and 403 — not 404 — is the
    // proof the project now resolves.
    await expect($fetch('/api/tf/acme/usable', { headers: authHeader() })).rejects.toMatchObject({
      statusCode: 403
    })
  })

  it('answers 409 for a duplicate slug in the same org, not 500', async () => {
    await create({ org: 'acme', project: 'twice' }, { cookie: sessionCookie })
    await expect(
      create({ org: 'acme', project: 'twice' }, { cookie: sessionCookie })
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('rejects a slug the router could never resolve', async () => {
    // Every one of these would either fail projectRefSchema on the way back in
    // or escape a blob-key prefix.
    for (const project of ['Uppercase', 'has/slash', '..', '-leading-dash', 'trailing ', '']) {
      await expect(
        create({ org: 'acme', project }, { cookie: sessionCookie })
      ).rejects.toMatchObject({ statusCode: 400 })
    }
  })

  it('answers 404 for an unknown organization', async () => {
    await expect(
      create({ org: 'no-such-org', project: 'anything' }, { cookie: sessionCookie })
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('records the creation in the audit log', async () => {
    const created = await create(
      { org: 'acme', project: 'audited' },
      {
        cookie: sessionCookie
      }
    )
    const rows = await db().select().from(auditLog).where(eq(auditLog.projectId, created.id))
    expect(rows.map((r) => r.action)).toContain('project.create')
  })
})

describe('lock visibility and release', () => {
  it('reports a lock whose client sent no Who', async () => {
    // Every LockInfo field but ID is optional, so this is a supported client.
    // The dashboard gated its badge, its banner and its Force Unlock button on
    // `lockedBy`, so a lock like this was held and completely invisible.
    await $fetch(`${url}/lock`, { method: 'POST', headers: authHeader(), body: { ID: 'quiet' } })

    const list = await $fetch('/api/ui/projects', { headers: { cookie: sessionCookie } })
    const row = list.find((p) => p.org === 'acme' && p.slug === 'prod')
    expect(row?.lockedBy).toBeNull()
    expect(row?.lockedAt).not.toBeNull()
  })

  it('answers 409 and keeps the lock when the release id does not match', async () => {
    // `terraform force-unlock <wrong-id>` used to print success and do nothing.
    await $fetch(`${url}/lock`, {
      method: 'POST',
      headers: authHeader(),
      body: { ID: 'real', Who: 'jj' }
    })

    await expect(
      $fetch(`${url}/lock`, { method: 'DELETE', headers: authHeader(), body: { ID: 'wrong' } })
    ).rejects.toMatchObject({ statusCode: 409, data: expect.objectContaining({ ID: 'real' }) })

    // Still held, so a second acquire still conflicts.
    await expect(
      $fetch(`${url}/lock`, { method: 'POST', headers: authHeader(), body: { ID: 'other' } })
    ).rejects.toMatchObject({ statusCode: 423 })
  })

  it('answers 200 when there is nothing to release', async () => {
    // Terraform sends UNLOCK at the end of an apply that worked. If someone
    // force-unlocked in the meantime, failing here would fail a good run.
    expect(
      await $fetch(`${url}/lock`, { method: 'DELETE', headers: authHeader(), body: { ID: 'gone' } })
    ).toMatchObject({ ok: true })
  })
})

describe('health endpoint', () => {
  it('answers a HEAD probe rather than redirecting it', async () => {
    // Uptime monitors default to HEAD. A GET-only route let it fall through to
    // the SPA catch-all, which answered 302 to /login.
    const response = await fetch(absoluteUrl('/api/health'), { method: 'HEAD' })
    expect(response.status).toBe(200)
  })

  it('still answers GET', async () => {
    const response = await fetch(absoluteUrl('/api/health'))
    expect(response.status).toBe(200)
  })
})
