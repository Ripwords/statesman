import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { $fetch, setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { auth } from '../../server/utils/auth'
import { seedProject, resetDb } from './helpers'

await setup({ server: true })

let token: string
const url = '/api/tf/acme/prod'
const authHeader = () => ({ authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` })
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
  const user = await auth.api.signUpEmail({
    body: { email: `e2e${Date.now()}@example.com`, password: 'correct horse battery', name: 'E' }
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
})

// This suite owns the 'acme' organization slug; see resetDb in ./helpers.
beforeEach(async () => {
  await resetDb('acme')
  await seedProject('acme', 'prod')
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
})
