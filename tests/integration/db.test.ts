import { describe, it, expect, beforeAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { organization, project } from '../../server/db/schema'

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
