import { describe, it, expect, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { organization, project } from '../../server/db/schema'

describe('database', () => {
  beforeAll(async () => {
    await db().delete(project)
    await db().delete(organization)
  })

  it('inserts and reads an organization', async () => {
    await db().insert(organization).values({ id: 'org1', name: 'Acme', slug: 'acme' })
    const rows = await db().select().from(organization).where(eq(organization.slug, 'acme'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Acme')
  })

  it('enforces unique project slug per organization', async () => {
    await db().insert(project).values({ id: 'p1', orgId: 'org1', name: 'Prod', slug: 'prod' })
    await expect(
      db().insert(project).values({ id: 'p2', orgId: 'org1', name: 'Dup', slug: 'prod' })
    ).rejects.toThrow()
  })
})
