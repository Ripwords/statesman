import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { $fetch, setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { auth } from '../../server/utils/auth'
import { acquireLock } from '../../server/services/lock'
import { seedProject, resetDb } from './helpers'

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
  const user = await auth.api.signUpEmail({
    body: { email, password: 'correct horse battery', name: 'E' }
  })
  const key = await auth.api.createApiKey({
    body: {
      userId: user.user.id,
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
      userId: user.user.id,
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
  sessionCookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
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
    await $fetch(`${url}/lock`, { method: 'POST', headers: authHeader(), body: { ID: 'a', Who: 'jj' } })
    await expect(
      $fetch(`${url}/lock`, { method: 'POST', headers: authHeader(), body: { ID: 'b', Who: 'other' } })
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
    await expect(
      $fetch('/api/tf/acme/staging', { headers: authHeader() })
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('returns 404 for an unknown project', async () => {
    await expect(
      $fetch('/api/tf/acme/nope', { headers: authHeader() })
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('deletes state', async () => {
    await $fetch(url, { method: 'POST', headers: authHeader(), body: state(1) })
    await $fetch(url, { method: 'DELETE', headers: authHeader() })
    await expect($fetch(url, { headers: authHeader() })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('returns 401 for a key that does not exist', async () => {
    await expect(
      $fetch(url, { headers: basicHeader('sm_not_a_real_key') })
    ).rejects.toMatchObject({ statusCode: 401 })
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
  it('rejects an unauthenticated retention run', async () => {
    await expect(
      $fetch('/api/admin/retention', { method: 'POST' })
    ).rejects.toMatchObject({ statusCode: 401 })
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
