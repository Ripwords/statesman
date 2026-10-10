import { testEvent, isApiError } from '../ui/nitro-globals'
import { describe, it, expect, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  provisionUser,
  signInHeaders,
  setRole,
  resetDb,
  seedProject,
  grantProjectRole
} from './helpers'
import { db } from '../../server/db/client'
import { apikey, projectMember, user } from '../../server/db/schema'
import { auth } from '../../server/utils/auth'
import { requireCreatorAccess, authenticateTf } from '../../server/utils/tf-auth'
import createToken from '../../server/api/ui/tokens.post'
import listTokens from '../../server/api/ui/tokens.get'
import deleteToken from '../../server/api/ui/tokens/[id].delete'

// The shared Nitro shim has no request-header helpers; authenticateTf needs two.
Object.assign(globalThis, {
  getRequestHeader: (event: { headers: Headers }, name: string) =>
    event.headers.get(name) ?? undefined,
  setResponseHeader: () => undefined
})

const ORG = 'token-ceiling'
const PASSWORD = 'correct horse battery staple'
let projectId: string
let owner: { id: string; email: string; h: Record<string, string> }
let editorId: string

async function mint(
  userId: string,
  scope: object,
  state: string[],
  vars: string[] = []
): Promise<string> {
  const key = await auth.api.createApiKey({
    body: {
      userId,
      name: 't',
      metadata: { scope },
      permissions: { state, ...(vars.length ? { vars } : {}) }
    }
  })
  return key.key
}

async function principalFor(key: string) {
  return authenticateTf(
    testEvent({ headers: { authorization: `Basic ${Buffer.from(`x:${key}`).toString('base64')}` } })
  )
}

async function status(call: Promise<unknown>): Promise<number | undefined> {
  try {
    await call
    return undefined
  } catch (e) {
    return isApiError(e) ? e.statusCode : undefined
  }
}

const resolved = () => ({
  id: projectId,
  orgId: '',
  ref: { org: ORG, project: 'p' },
  archived: false
})

beforeAll(async () => {
  await resetDb(ORG)
  projectId = await seedProject(ORG, 'p')
  const stamp = Date.now()
  const o = await provisionUser(`tc-owner-${stamp}@example.com`, PASSWORD)
  const e = await provisionUser(`tc-editor-${stamp}@example.com`, PASSWORD)
  await setRole(o.id, 'member')
  await setRole(e.id, 'member')
  await grantProjectRole(projectId, o.id, 'owner')
  await grantProjectRole(projectId, e.id, 'editor')
  owner = { ...o, h: Object.fromEntries((await signInHeaders(o.email, PASSWORD)).entries()) }
  editorId = e.id
})

describe('use-time ceiling', () => {
  it('lets an owner token write and read vars', async () => {
    const p = await principalFor(
      await mint(
        owner.id,
        { kind: 'projects', projects: [`${ORG}/p`] },
        ['read', 'write'],
        ['read']
      )
    )
    await expect(requireCreatorAccess(p, resolved(), 'state:write')).resolves.toBeUndefined()
    await expect(requireCreatorAccess(p, resolved(), 'vars:read')).resolves.toBeUndefined()
  })

  it('refuses vars read when the creator is only an editor', async () => {
    const p = await principalFor(
      await mint(editorId, { kind: 'projects', projects: [`${ORG}/p`] }, ['read'], ['read'])
    )
    expect(await status(requireCreatorAccess(p, resolved(), 'vars:read'))).toBe(403)
    await expect(requireCreatorAccess(p, resolved(), 'state:write')).resolves.toBeUndefined()
  })

  it('stops working when the creator is demoted to viewer, and works again when restored', async () => {
    const key = await mint(editorId, { kind: 'projects', projects: [`${ORG}/p`] }, [
      'read',
      'write'
    ])
    await grantProjectRole(projectId, editorId, 'viewer')
    expect(
      await status(requireCreatorAccess(await principalFor(key), resolved(), 'state:write'))
    ).toBe(403)
    await expect(
      requireCreatorAccess(await principalFor(key), resolved(), 'state:read')
    ).resolves.toBeUndefined()
    await grantProjectRole(projectId, editorId, 'editor')
    await expect(
      requireCreatorAccess(await principalFor(key), resolved(), 'state:write')
    ).resolves.toBeUndefined()
  })

  it('refuses after the creator is removed from the project', async () => {
    const stamp = Date.now()
    const x = await provisionUser(`tc-removed-${stamp}@example.com`, PASSWORD)
    await setRole(x.id, 'member')
    await grantProjectRole(projectId, x.id, 'owner')
    const key = await mint(x.id, { kind: 'projects', projects: [`${ORG}/p`] }, ['read'])
    await db().delete(projectMember).where(eq(projectMember.userId, x.id))
    expect(
      await status(requireCreatorAccess(await principalFor(key), resolved(), 'state:read'))
    ).toBe(403)
  })

  it('disarms an all-scope token when its creator stops being an admin', async () => {
    const stamp = Date.now()
    const a = await provisionUser(`tc-admin-${stamp}@example.com`, PASSWORD)
    await setRole(a.id, 'admin')
    const key = await mint(a.id, { kind: 'all' }, ['read'])
    await expect(
      requireCreatorAccess(await principalFor(key), resolved(), 'state:read')
    ).resolves.toBeUndefined()
    await setRole(a.id, 'member')
    await grantProjectRole(projectId, a.id, 'owner')
    expect(
      await status(requireCreatorAccess(await principalFor(key), resolved(), 'state:read'))
    ).toBe(403)
  })

  it('refuses a token whose creator account was deleted', async () => {
    const stamp = Date.now()
    const x = await provisionUser(`tc-deleted-${stamp}@example.com`, PASSWORD)
    await setRole(x.id, 'member')
    await grantProjectRole(projectId, x.id, 'owner')
    const key = await mint(x.id, { kind: 'projects', projects: [`${ORG}/p`] }, ['read'])
    const before = await principalFor(key)
    await db().delete(user).where(eq(user.id, x.id))
    // The key row may cascade away with its owner (401 at authenticateTf), or
    // survive (403 here). Either refuses; neither is a 500.
    const s = await status(
      (async () =>
        requireCreatorAccess(
          await principalFor(key).catch(() => before),
          resolved(),
          'state:read'
        ))()
    )
    expect([401, 403]).toContain(s)
  })
})

describe('admin creator', () => {
  it('passes for a projects-scope token with no membership row', async () => {
    const a = await provisionUser(`tc-adm2-${Date.now()}@example.com`, PASSWORD, 'admin')
    const key = await mint(a.id, { kind: 'projects', projects: [`${ORG}/p`] }, ['write'], ['read'])
    const p = await principalFor(key)
    await expect(requireCreatorAccess(p, resolved(), 'state:write')).resolves.toBeUndefined()
    await expect(requireCreatorAccess(p, resolved(), 'vars:read')).resolves.toBeUndefined()
  })
})

describe('creation rules', () => {
  it('refuses a non-admin an all-scope token', async () => {
    expect(
      await status(
        createToken(
          testEvent({
            headers: owner.h,
            body: { name: 'x', actions: ['read'], scope: { kind: 'all' } }
          })
        )
      )
    ).toBe(403)
  })

  it('refuses a token naming a project the caller does not own', async () => {
    const other = await seedProject(ORG, 'other')
    await grantProjectRole(other, owner.id, 'editor')
    expect(
      await status(
        createToken(
          testEvent({
            headers: owner.h,
            body: {
              name: 'x',
              actions: ['read'],
              scope: { kind: 'projects', projects: [`${ORG}/p`, `${ORG}/other`] }
            }
          })
        )
      )
    ).toBe(403)
  })

  it('refuses a token naming an unknown project with the same 403', async () => {
    expect(
      await status(
        createToken(
          testEvent({
            headers: owner.h,
            body: {
              name: 'x',
              actions: ['read'],
              scope: { kind: 'projects', projects: [`${ORG}/nonexistent`] }
            }
          })
        )
      )
    ).toBe(403)
  })

  it('lets an owner create a vars-read token for their project', async () => {
    const res = await createToken(
      testEvent({
        headers: owner.h,
        body: {
          name: 'x',
          actions: [],
          varActions: ['read'],
          scope: { kind: 'projects', projects: [`${ORG}/p`] }
        }
      })
    )
    expect(res.key).toMatch(/^sm_/)
  })
})

describe('revocation', () => {
  it('lets a former owner, now a viewer, list and revoke their own token', async () => {
    const stamp = Date.now()
    const f = await provisionUser(`tc-former-${stamp}@example.com`, PASSWORD)
    await setRole(f.id, 'member')
    await grantProjectRole(projectId, f.id, 'owner')
    const h = Object.fromEntries((await signInHeaders(f.email, PASSWORD)).entries())
    const created = await createToken(
      testEvent({
        headers: h,
        body: {
          name: 'mine',
          actions: ['read'],
          scope: { kind: 'projects', projects: [`${ORG}/p`] }
        }
      })
    )
    await grantProjectRole(projectId, f.id, 'viewer')
    const listed = await listTokens(testEvent({ headers: h }))
    expect(listed.map((k) => k.id)).toContain(created.id)
    await deleteToken(testEvent({ headers: h, params: { id: created.id } }))
    const after = await db().select({ id: apikey.id }).from(apikey).where(eq(apikey.id, created.id))
    expect(after).toHaveLength(0)
  })

  it('does not let a non-admin owner delete a token created by someone else', async () => {
    const stamp = Date.now()
    const other = await provisionUser(`tc-other-${stamp}@example.com`, PASSWORD)
    await setRole(other.id, 'admin')
    await mint(other.id, { kind: 'all' }, ['read'])
    const rows = await db()
      .select({ id: apikey.id })
      .from(apikey)
      .where(eq(apikey.referenceId, other.id))
    const keyId = rows[0]?.id
    expect(keyId).toBeDefined()

    const s = await status(
      deleteToken(testEvent({ headers: owner.h, params: { id: keyId ?? '' } }))
    )
    expect(s).toBe(404)
    const after = await db()
      .select({ id: apikey.id })
      .from(apikey)
      .where(eq(apikey.id, keyId ?? ''))
    expect(after).toHaveLength(1)
  })
})
