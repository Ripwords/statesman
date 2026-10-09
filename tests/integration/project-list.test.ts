import { testEvent } from '../ui/nitro-globals'
import { describe, it, expect, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  provisionUser,
  signInHeaders,
  setRole,
  resetDb,
  seedOrg,
  seedProject,
  grantProjectRole
} from '../protocol/helpers'
import { db } from '../../server/db/client'
import { projectAccess, project } from '../../server/db/schema'
import listProjects from '../../server/api/ui/projects.get'
import createProject from '../../server/api/ui/projects.post'

const ORG = 'project-list'
const PASSWORD = 'correct horse battery staple'
let admin: Record<string, string>
let member: Record<string, string>
let mine: string
let theirs: string

beforeAll(async () => {
  await resetDb(ORG)
  await seedOrg(ORG)
  mine = await seedProject(ORG, 'mine')
  theirs = await seedProject(ORG, 'theirs')
  const stamp = Date.now()
  const a = await provisionUser(`pl-admin-${stamp}@example.com`, PASSWORD)
  const m = await provisionUser(`pl-member-${stamp}@example.com`, PASSWORD)
  await setRole(a.id, 'admin')
  await setRole(m.id, 'member')
  await grantProjectRole(mine, m.id, 'editor')
  admin = Object.fromEntries((await signInHeaders(a.email, PASSWORD)).entries())
  member = Object.fromEntries((await signInHeaders(m.email, PASSWORD)).entries())
})

describe('GET /api/ui/projects', () => {
  it('shows a member only the projects they hold a role on, with that role', async () => {
    const rows = (await listProjects(testEvent({ headers: member }))).filter((r) => r.org === ORG)
    expect(rows.map((r) => [r.id, r.myRole])).toEqual([[mine, 'editor']])
  })

  it('shows an admin every project as admin', async () => {
    const rows = (await listProjects(testEvent({ headers: admin }))).filter((r) => r.org === ORG)
    expect(rows.map((r) => r.id).toSorted()).toEqual([mine, theirs].toSorted())
    expect(new Set(rows.map((r) => r.myRole))).toEqual(new Set(['admin']))
  })
})

describe('POST /api/ui/projects', () => {
  it('creates the access record alongside the project', async () => {
    await createProject(testEvent({ headers: admin, body: { org: ORG, project: 'fresh' } }))
    const [row] = await db()
      .select({ id: project.id })
      .from(project)
      .where(eq(project.slug, 'fresh'))
    expect(
      await db()
        .select()
        .from(projectAccess)
        .where(eq(projectAccess.id, row?.id ?? ''))
    ).toHaveLength(1)
  })
})
