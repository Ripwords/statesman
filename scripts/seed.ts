import { existsSync } from 'node:fs'
import { ulid } from 'ulid'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { schema, organization, project } from '../server/db/schema'
import { projectSlug } from '../shared/schemas/project'

// Run outside Nitro, so nothing has loaded .env yet.
if (existsSync('.env')) process.loadEnvFile('.env')

// Deliberately NOT server/db/client: that reaches env(), which demands an
// encryption key, an auth secret and a base URL. A seeding CLI that touches two
// metadata tables has no business holding the key that decrypts state, and
// requiring it would mean handing those secrets to the migration container too.
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required to seed')

const pool = new Pool({ connectionString: url })
const db = drizzle(pool, { schema })

const orgSlug = projectSlug.parse(process.env.STATESMAN_ORG_SLUG ?? 'acme')

// There is no project-creation endpoint or UI: spec §9 resolves :org/:project
// and answers 404 when it is unknown, so a project has to exist before the
// first `terraform init` against it. This is the only thing that makes one.
const projectSlugs = (process.env.STATESMAN_SEED_PROJECTS ?? 'prod')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => projectSlug.parse(s))

// Spec §5: one organization per deployment. So the fallback is "any
// organization at all", not "one with this slug" — a re-run after a rename must
// not quietly create a second one. ORDER BY makes the choice deterministic when
// a database somehow has several.
const named = await db.select().from(organization).where(eq(organization.slug, orgSlug))
const [firstAny] = await db.select().from(organization).orderBy(organization.slug).limit(1)
const existing = named[0] ?? firstAny

let orgId: string
let ownerSlug: string
if (existing) {
  orgId = existing.id
  ownerSlug = existing.slug
  console.log(`Organization already seeded: ${existing.slug}`)
} else {
  orgId = ulid()
  ownerSlug = orgSlug
  await db.insert(organization).values({ id: orgId, name: orgSlug, slug: orgSlug })
  console.log(`Seeded organization: ${orgSlug}`)
}

for (const slug of projectSlugs) {
  const inserted = await db
    .insert(project)
    .values({ id: ulid(), orgId, name: slug, slug })
    // The unique index is (org_id, slug), so a re-run is a no-op rather than an
    // error, and adding a project later means re-running with a longer list.
    .onConflictDoNothing({ target: [project.orgId, project.slug] })
    .returning()

  console.log(
    inserted.length > 0
      ? `Seeded project: ${ownerSlug}/${slug}`
      : `Project already seeded: ${ownerSlug}/${slug}`
  )
}

await pool.end()
