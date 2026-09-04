import { existsSync } from 'node:fs'
import { ulid } from 'ulid'

// Run outside Nitro, so nothing has loaded .env yet. env() reads process.env
// at first use and this import graph reaches it, so the file has to be loaded
// before server/db/client is imported.
if (existsSync('.env')) process.loadEnvFile('.env')

const { db } = await import('../server/db/client')
const { organization } = await import('../server/db/schema')

// Spec §5: v1 runs one organization per deployment, seeded once at first boot.
// The check is "any organization at all", not "this slug", so re-running after
// a rename does not quietly create a second one.
const [existing] = await db().select().from(organization).limit(1)

if (existing) {
  console.log(`Organization already seeded: ${existing.slug}`)
} else {
  const slug = process.env.STATESMAN_ORG_SLUG ?? 'acme'
  await db().insert(organization).values({ id: ulid(), name: slug, slug })
  console.log(`Seeded organization: ${slug}`)
}

// The pg Pool holds the event loop open; nothing else is pending.
process.exit(0)
