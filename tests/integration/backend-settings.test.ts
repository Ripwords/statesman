import { describe, it, expect, beforeAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { testEvent, isApiError } from '../ui/nitro-globals'
import {
  provisionUser,
  signInHeaders,
  setRole,
  resetDb,
  seedProject,
  grantProjectRole
} from '../protocol/helpers'
import { db } from '../../server/db/client'
import { auditLog, project } from '../../server/db/schema'
import { createEnvironment, readBackend } from '../../server/services/variables'
import putBackend from '../../server/api/ui/environments/[id]/backend.put'
import listEnvironments from '../../server/api/ui/projects/[id]/environments.get'

const ORG = 'backend-settings'
const PASSWORD = 'correct horse battery staple'
let projectId: string
let envId: string
let owner: Record<string, string>
let editor: Record<string, string>

const put = (h: Record<string, string>, body: unknown, id = envId) =>
  putBackend(testEvent({ headers: h, params: { id }, body }))

async function statusOf(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise
    return { status: 200, message: '' }
  } catch (error) {
    if (!isApiError(error)) throw error
    return { status: error.statusCode, message: error.statusMessage ?? '' }
  }
}

beforeAll(async () => {
  await resetDb(ORG)
  projectId = await seedProject(ORG, 'p')
  envId = (await createEnvironment(projectId, 'client')).id
  const stamp = Date.now()
  for (const role of ['owner', 'editor'] as const) {
    const u = await provisionUser(`bs-${role}-${stamp}@example.com`, PASSWORD)
    await setRole(u.id, 'member')
    await grantProjectRole(projectId, u.id, role)
    const h = Object.fromEntries((await signInHeaders(u.email, PASSWORD)).entries())
    if (role === 'owner') owner = h
    else editor = h
  }
})

describe('PUT /api/ui/environments/:id/backend', () => {
  it('stores a map and lists it with the environment', async () => {
    const result = await put(owner, { backend: { bucket: 'b', region: 'ap-southeast-1' } })
    expect(result).toEqual({ backend: { bucket: 'b', region: 'ap-southeast-1' } })
    const list = await listEnvironments(testEvent({ headers: owner, params: { id: projectId } }))
    expect(list).toEqual([
      { id: envId, slug: 'client', backend: { bucket: 'b', region: 'ap-southeast-1' } }
    ])
  })

  it('parses pasted HCL', async () => {
    await put(owner, { hcl: 'bucket = "from-hcl"\nencrypt = true\n' })
    expect(await readBackend(envId)).toEqual({ bucket: 'from-hcl', encrypt: true })
  })

  it('clears with null and with empty HCL', async () => {
    await put(owner, { backend: null })
    expect(await readBackend(envId)).toBeNull()
    await put(owner, { backend: { bucket: 'b' } })
    await put(owner, { hcl: '  \n' })
    expect(await readBackend(envId)).toBeNull()
  })

  it('answers 400 naming a credential-like key', async () => {
    const r = await statusOf(put(owner, { backend: { secret_key: 'x' } }))
    expect(r.status).toBe(400)
    expect(r.message).toContain('secret_key')
  })

  it('answers 400 with a line number for HCL with an expression or a nested block', async () => {
    const expr = await statusOf(put(owner, { hcl: 'bucket = "b"\nregion = var.region\n' }))
    expect(expr.status).toBe(400)
    expect(expr.message).toMatch(/:2:/)
    const nested = await statusOf(put(owner, { hcl: 'assume_role = { role_arn = "x" }\n' }))
    expect(nested.status).toBe(400)
    expect(nested.message).toContain('assume_role')
    const block = await statusOf(
      put(owner, { hcl: 'bucket = "b"\nassume_role {\n  role_arn = "x"\n}\n' })
    )
    expect(block.status).toBe(400)
    expect(block.message).toMatch(/:2:/)
  })

  it('refuses an editor with 403', async () => {
    expect((await statusOf(put(editor, { backend: null }))).status).toBe(403)
  })

  it('audits key names, never values', async () => {
    await put(owner, { backend: { bucket: 'audit-me' } })
    const rows = await db()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'environment.backend.update'), eq(auditLog.projectId, projectId))
      )
    const last = rows.at(-1)
    expect(last?.metaJson).toEqual({ environment: 'client', keys: ['bucket'] })
    expect(JSON.stringify(rows)).not.toContain('audit-me')
  })

  it('answers 409 on an archived project', async () => {
    await db().update(project).set({ archivedAt: new Date() }).where(eq(project.id, projectId))
    try {
      expect((await statusOf(put(owner, { backend: null }))).status).toBe(409)
    } finally {
      await db().update(project).set({ archivedAt: null }).where(eq(project.id, projectId))
    }
  })
})
