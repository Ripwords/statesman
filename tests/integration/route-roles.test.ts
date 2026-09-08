import { describe, it, expect, beforeAll } from 'vitest'
import { testEvent, isApiError } from '../ui/nitro-globals'
import { provisionUser, signInHeaders, setRole, seedOrg, resetDb } from '../protocol/helpers'

import listProjects from '../../server/api/ui/projects.get'
import createProject from '../../server/api/ui/projects.post'
import listVersions from '../../server/api/ui/projects/[id]/versions.get'
import readVersion from '../../server/api/ui/versions/[id].get'
import forceUnlock from '../../server/api/ui/projects/[id]/lock.delete'
import listTokens from '../../server/api/ui/tokens.get'
import createToken from '../../server/api/ui/tokens.post'
import deleteToken from '../../server/api/ui/tokens/[id].delete'
import rollback from '../../server/api/admin/rollback.post'
import retention from '../../server/api/admin/retention.post'

const PASSWORD = 'correct horse battery staple'
const ORG = 'route-roles'

let admin: Record<string, string>
let member: Record<string, string>

beforeAll(async () => {
  await resetDb(ORG)
  await seedOrg(ORG)
  const stamp = Date.now()
  const a = await provisionUser(`rr-admin-${stamp}@example.com`, PASSWORD)
  const m = await provisionUser(`rr-member-${stamp}@example.com`, PASSWORD)
  await setRole(a.id, 'admin')
  await setRole(m.id, 'member')
  admin = Object.fromEntries((await signInHeaders(a.email, PASSWORD)).entries())
  member = Object.fromEntries((await signInHeaders(m.email, PASSWORD)).entries())
})

/**
 * Every route that CHANGES something. Each is driven with a member's real
 * session; the assertion is 403 and nothing else, which also pins that the
 * guard runs before the body or route parameter is read — several of these are
 * called with no body at all and would be a 400 if the order ever flipped.
 */
const ADMIN_ROUTES: Array<[string, (headers: Record<string, string>) => Promise<unknown>]> = [
  [
    'POST /api/ui/projects',
    (h) => createProject(testEvent({ headers: h, body: { project: 'x' } }))
  ],
  [
    'DELETE /api/ui/projects/:id/lock',
    (h) => forceUnlock(testEvent({ headers: h, params: { id: 'p1' } }))
  ],
  ['GET /api/ui/tokens', (h) => listTokens(testEvent({ headers: h }))],
  ['POST /api/ui/tokens', (h) => createToken(testEvent({ headers: h, body: {} }))],
  [
    'DELETE /api/ui/tokens/:id',
    (h) => deleteToken(testEvent({ headers: h, params: { id: 'k1' } }))
  ],
  ['POST /api/admin/rollback', (h) => rollback(testEvent({ headers: h, body: {} }))],
  ['POST /api/admin/retention', (h) => retention(testEvent({ headers: h }))]
]

describe.each(ADMIN_ROUTES)('%s', (_name, call) => {
  it('refuses a member with 403', async () => {
    await expect(call(member)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('refuses an anonymous caller with 401', async () => {
    await expect(call({})).rejects.toMatchObject({ statusCode: 401 })
  })

  it('does not answer 403 to an admin', async () => {
    // The call may still fail on its own terms — a token id that does not
    // exist, an empty body — and that is fine. What must not happen is the
    // authorization refusal, so only the status is asserted, always.
    expect(await statusOf(call(admin))).not.toBe(403)
  })
})

/**
 * Reading is a member's job. These must not become admin-only by accident,
 * which is the likeliest way this change breaks: a guard swapped one line too
 * far down the file.
 */
const READ_ROUTES: Array<[string, (headers: Record<string, string>) => Promise<unknown>]> = [
  ['GET /api/ui/projects', (h) => listProjects(testEvent({ headers: h }))],
  [
    'GET /api/ui/projects/:id/versions',
    (h) => listVersions(testEvent({ headers: h, params: { id: 'p1' } }))
  ],
  [
    'GET /api/ui/versions/:id',
    (h) => readVersion(testEvent({ headers: h, params: { id: '01ABC' } }))
  ]
]

describe.each(READ_ROUTES)('%s', (_name, call) => {
  it('lets a member through', async () => {
    expect(await statusOf(call(member))).not.toBe(403)
  })

  it('still refuses an anonymous caller with 401', async () => {
    await expect(call({})).rejects.toMatchObject({ statusCode: 401 })
  })
})

/**
 * The status a call refused with, or undefined when it did not refuse. Returning
 * the status rather than asserting inside a `catch` keeps every expectation
 * unconditional — a `catch` that never runs is a test that never asserted.
 */
async function statusOf(call: Promise<unknown>): Promise<number | undefined> {
  try {
    await call
    return undefined
  } catch (error) {
    return isApiError(error) ? error.statusCode : undefined
  }
}
