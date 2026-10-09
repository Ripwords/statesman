import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { environment, organization, project, variable } from '../../server/db/schema'
import { resetDb, seedProject } from '../protocol/helpers'

// Vitest runs test FILES in parallel against one database. An unscoped
// `delete(project)` here truncated whatever another suite was mid-way through,
// so every suite owns its own organization and deletes only its own rows.
const ORG_ID = 'db-suite-org'
const ORG_SLUG = 'db-suite'

describe('database', () => {
  beforeAll(async () => {
    await db().delete(project).where(eq(project.orgId, ORG_ID))
    await db().delete(organization).where(eq(organization.id, ORG_ID))
  })

  it('inserts and reads an organization', async () => {
    await db().insert(organization).values({ id: ORG_ID, name: 'DB Suite', slug: ORG_SLUG })
    const rows = await db().select().from(organization).where(eq(organization.slug, ORG_SLUG))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('DB Suite')
  })

  it('enforces unique project slug per organization', async () => {
    await db()
      .insert(project)
      .values({ id: 'db-suite-p1', orgId: ORG_ID, name: 'Prod', slug: 'prod' })
    await expect(
      db().insert(project).values({ id: 'db-suite-p2', orgId: ORG_ID, name: 'Dup', slug: 'prod' })
    ).rejects.toThrow()
  })

  it('allows the same project slug in a different organization', async () => {
    // The uniqueness constraint is (org_id, slug), not slug alone. Without this
    // the previous test would pass against a global unique index too.
    const otherOrgId = 'db-suite-org-2'
    await db().delete(project).where(eq(project.orgId, otherOrgId))
    await db().delete(organization).where(eq(organization.id, otherOrgId))
    await db()
      .insert(organization)
      .values({ id: otherOrgId, name: 'Other', slug: 'db-suite-other' })
    await db()
      .insert(project)
      .values({ id: 'db-suite-p3', orgId: otherOrgId, name: 'Prod', slug: 'prod' })

    const rows = await db()
      .select()
      .from(project)
      .where(and(eq(project.orgId, otherOrgId), eq(project.slug, 'prod')))
    expect(rows).toHaveLength(1)
  })
})

describe('variables tables', () => {
  const ORG = 'db-variables'

  beforeEach(async () => {
    await resetDb(ORG)
  })

  it('cascades environment and variables when the project goes', async () => {
    const projectId = await seedProject(ORG, 'p')
    await db().insert(environment).values({ id: 'env-db-1', projectId, slug: 'dev' })
    await db().insert(variable).values({
      id: 'var-db-1',
      environmentId: 'env-db-1',
      name: 'x',
      valueSealed: 'AAAA'
    })
    await resetDb(ORG)
    const left = await db().select().from(variable).where(eq(variable.id, 'var-db-1'))
    expect(left).toHaveLength(0)
  })

  it('refuses two variables with one name in one environment', async () => {
    const projectId = await seedProject(ORG, 'p')
    await db().insert(environment).values({ id: 'env-db-2', projectId, slug: 'dev' })
    const row = { environmentId: 'env-db-2', name: 'x', valueSealed: 'AAAA' }
    await db()
      .insert(variable)
      .values({ id: 'var-db-2', ...row })
    await expect(
      db()
        .insert(variable)
        .values({ id: 'var-db-3', ...row })
    ).rejects.toThrow()
  })

  it('defaults sensitive to true', async () => {
    const projectId = await seedProject(ORG, 'p')
    await db().insert(environment).values({ id: 'env-db-3', projectId, slug: 'dev' })
    await db()
      .insert(variable)
      .values({ id: 'var-db-4', environmentId: 'env-db-3', name: 'y', valueSealed: 'AAAA' })
    const [row] = await db().select().from(variable).where(eq(variable.id, 'var-db-4'))
    expect(row?.sensitive).toBe(true)
  })
})
