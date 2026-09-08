# statesman Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship a self-hostable Terraform HTTP state backend with encrypted state at rest, full version history, and scoped API tokens.

**Architecture:** One Nuxt 4 app serving two entrances — the Terraform HTTP protocol under `/api/tf/*` (Basic Auth, API keys) and a web dashboard (Better Auth sessions). Postgres is the source of truth for locks, metadata, and pointers; an S3-compatible or local blob store holds AES-256-GCM ciphertext. Storage and database each sit behind a one-interface adapter chosen by environment variable, so the same build runs on Vercel+Neon+S3 and on Docker Compose+node-postgres+local disk.

**Tech Stack:** Nuxt 4.5.2, Nuxt UI 4.11.0, Zod 4.5.4, Better Auth 1.7.2 (+ API Key plugin), Drizzle ORM 0.45.2, `@neondatabase/serverless` 1.1.0, `pg` 8.23.0, Vitest, Node 24.4.1, pnpm 10.17.1.

**Spec:** `docs/superpowers/specs/2026-09-04-statesman-design.md`

---

## Global Constraints

- **Never use `any`.** Use `as unknown as X` only where strictly necessary. (Project convention.)
- **TDD.** Every task writes the failing test first, watches it fail, then implements.
- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- **No `fetch` + `useEffect`-style data fetching.** Use Nuxt's `useFetch`/`useAsyncData` on the client.
- **Encryption is mandatory.** `STATESMAN_ENCRYPTION_KEY` absent ⇒ process refuses to boot.
- **Postgres is the only lock arbiter.** No advisory locks, no Redis, no in-memory state.
- **Blob objects are immutable.** Never overwrite a `blob_key`; every write gets a fresh ULID.
- **Write ordering is fixed:** blob `put` → `state_version` insert → `project_state` pointer update. An orphan blob is acceptable; a dangling pointer is data loss.
- **Zod validates every boundary** (env, request bodies, form input). Zod never validates Terraform state file contents.
- **Always use h3's validated request utils** — `readValidatedBody(event, schema.parse)`,
  `getValidatedQuery(event, schema.parse)`, `getValidatedRouterParams(event, schema.parse)`.
  Never `readBody` / `getQuery` / `getRouterParam` followed by a separate `.parse` or
  `.safeParse`. The validated utils bind the schema to the read so a boundary cannot be
  read without being validated.
  Two rules ride with this:
  1. **h3 rewrites every validator throw into a 400.** `validateData` catches whatever the
     validator throws and re-raises `createError({ status: 400, statusMessage: 'Validation
     Error' })`. A `createError({ statusCode: 404 })` thrown inside a validator is swallowed.
     Where the spec demands a different status (§11: an unknown project is 404, not 400),
     call the util inside a `try`/`catch` and rethrow the status the spec requires.
  2. **The Terraform state body is the one exception.** It is read with `readRawBody` and
     never passed through Zod — the document's shape belongs to Terraform, and validating
     it would couple us to their internal format across versions. Do not "fix" this.
- **Nuxt UI semantic colors only** — `primary`/`secondary`/`success`/`info`/`warning`/`error`/`neutral`. Never raw Tailwind palette colors in components.
- **All frontend work is audited against the Web Interface Guidelines** (see Appendix A) before its task is considered done.
- Exact versions above are floors; do not upgrade major versions.

---

## Execution Topology

```
        ┌──────────────────────────────────────────┐
        │ PHASE 0 — Foundation (ONE agent, blocking)│
        │ scaffold · env · db · storage · crypto    │
        │ auth · shared schemas · app.config        │
        └────────────────────┬─────────────────────┘
                             │ contracts frozen
              ┌──────────────┴──────────────┐
              ▼                             ▼
   ┌─────────────────────┐      ┌──────────────────────┐
   │ LANE A — Protocol   │      │ LANE B — Dashboard   │
   │ agent: backend      │ ║    │ agent: frontend      │
   │ Tasks A1–A6         │ ║    │ Tasks B1–B6          │
   │ owns server/api/tf  │ ║    │ owns app/**          │
   │      server/services│ ║    │      server/api/ui   │
   └──────────┬──────────┘      └──────────┬───────────┘
              └──────────────┬─────────────┘
                             ▼
        ┌──────────────────────────────────────────┐
        │ PHASE 2 — Integration (ONE agent)         │
        │ real terraform E2E · compose · vercel · docs│
        └──────────────────────────────────────────┘
```

**File ownership is disjoint by construction.** Lane A never edits `app/**` or `server/api/ui/**`. Lane B never edits `server/api/tf/**` or `server/services/**`. Both read Phase 0 output; neither modifies it. If either lane believes it must change a Phase 0 file, it stops and reports rather than editing — that is a contract break and the orchestrator resolves it.

---

## File Structure

### Phase 0 — shared foundation (frozen after Phase 0)

| File | Responsibility |
|---|---|
| `package.json`, `nuxt.config.ts`, `tsconfig.json`, `vitest.config.ts` | Project scaffold |
| `app.config.ts` | Nuxt UI semantic color mapping |
| `server/utils/env.ts` | Zod-parsed environment, validated once at boot |
| `server/db/schema.ts` | Drizzle tables (app + Better Auth) |
| `server/db/client.ts` | Driver switch: `neon` \| `node` |
| `server/storage/types.ts` | `StateStore` interface |
| `server/storage/s3.ts` | S3-compatible adapter |
| `server/storage/local.ts` | Local filesystem adapter |
| `server/storage/index.ts` | Driver switch + boot guard |
| `server/utils/crypto.ts` | AES-256-GCM seal/open |
| `server/utils/auth.ts` | Better Auth instance + API Key plugin |
| `shared/schemas/*.ts` | Zod schemas shared by both lanes |
| `shared/types.ts` | Types derived from those schemas |

### Lane A — Terraform protocol

| File | Responsibility |
|---|---|
| `server/utils/tf-auth.ts` | Basic Auth decode → `verifyApiKey` → scope guard |
| `server/services/lock.ts` | Acquire / release / force-release |
| `server/services/state.ts` | Read current, write version, purge |
| `server/services/audit.ts` | Append audit rows |
| `server/services/retention.ts` | Prune old versions, sweep orphan blobs |
| `server/api/tf/[org]/[project]/index.ts` | GET / POST / DELETE / LOCK / UNLOCK |
| `server/api/tf/[org]/[project]/lock.ts` | POST / DELETE / LOCK / UNLOCK |
| `tests/protocol/*.test.ts` | Protocol + authorization tests |

### Lane B — dashboard

| File | Responsibility |
|---|---|
| `app/layouts/dashboard.vue` | Shell: sidebar, header, color mode |
| `app/pages/index.vue` | Project list |
| `app/pages/projects/[slug].vue` | Version timeline |
| `app/pages/projects/[slug]/diff.vue` | Version diff |
| `app/pages/tokens.vue` | Token list |
| `app/components/TokenConfigurator.vue` | Token builder form |
| `app/components/StateDiff.vue` | JSON diff renderer |
| `app/components/LockBanner.vue` | Lock status + force-unlock |
| `server/api/ui/**` | Dashboard read endpoints + token CRUD |
| `tests/ui/*.test.ts` | Component and endpoint tests |

---

# PHASE 0 — Foundation

**Runs alone. Both lanes block on it.** One agent, tasks in order. When Phase 0 is merged, its files are frozen.

---

### Task 0.1: Scaffold and validated environment

**Files:**
- Create: `package.json`, `nuxt.config.ts`, `tsconfig.json`, `vitest.config.ts`
- Create: `server/utils/env.ts`
- Create: `.env.example`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadEnv(source?: NodeJS.ProcessEnv): Env` — throws on invalid config. `type Env` with fields `DATABASE_URL: string`, `DB_DRIVER: 'neon' | 'node'`, `STORAGE_DRIVER: 's3' | 'local'`, `ENCRYPTION_KEY: Buffer`, `LOCAL_STORAGE_PATH: string`, `S3_BUCKET?: string`, `S3_ENDPOINT?: string`, `S3_REGION: string`, `S3_ACCESS_KEY_ID?: string`, `S3_SECRET_ACCESS_KEY?: string`, `BETTER_AUTH_SECRET: string`, `BETTER_AUTH_URL: string`, `RETENTION_KEEP_VERSIONS: number`, `RETENTION_KEEP_DAYS: number`, `IS_SERVERLESS: boolean`

- [x] **Step 1: Initialise the project**

```bash
cd /Users/jiajingteoh/Documents/statesman
pnpm init
pnpm add nuxt@4.5.2 @nuxt/ui@4.11.0 zod@4.5.4 better-auth@1.7.2 \
  drizzle-orm@0.45.2 @neondatabase/serverless@1.1.0 pg@8.23.0 \
  @aws-sdk/client-s3 ulid
pnpm add -D vitest @vitest/coverage-v8 drizzle-kit @types/pg typescript vue-tsc
```

- [x] **Step 2: Write the failing test**

```ts
// tests/unit/env.test.ts
import { describe, it, expect } from 'vitest'
import { loadEnv } from '../../server/utils/env'

const KEY = Buffer.alloc(32, 7).toString('base64')

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/statesman',
  STATESMAN_ENCRYPTION_KEY: KEY,
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000'
}

describe('loadEnv', () => {
  it('parses a minimal valid environment', () => {
    const env = loadEnv({ ...base } as NodeJS.ProcessEnv)
    expect(env.DB_DRIVER).toBe('node')
    expect(env.STORAGE_DRIVER).toBe('local')
    expect(env.ENCRYPTION_KEY).toHaveLength(32)
  })

  it('refuses to start without an encryption key', () => {
    const { STATESMAN_ENCRYPTION_KEY, ...withoutKey } = base
    expect(() => loadEnv(withoutKey as NodeJS.ProcessEnv))
      .toThrow(/STATESMAN_ENCRYPTION_KEY/)
  })

  it('rejects an encryption key that is not 32 bytes', () => {
    const short = { ...base, STATESMAN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }
    expect(() => loadEnv(short as NodeJS.ProcessEnv)).toThrow(/32 bytes/)
  })

  it('rejects local storage on a serverless platform', () => {
    const bad = { ...base, STORAGE_DRIVER: 'local', VERCEL: '1' }
    expect(() => loadEnv(bad as NodeJS.ProcessEnv))
      .toThrow(/ephemeral/i)
  })

  it('requires a bucket when the s3 driver is selected', () => {
    const bad = { ...base, STORAGE_DRIVER: 's3' }
    expect(() => loadEnv(bad as NodeJS.ProcessEnv)).toThrow(/S3_BUCKET/)
  })
})
```

- [x] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run tests/unit/env.test.ts`
Expected: FAIL — cannot resolve `server/utils/env`.

- [x] **Step 4: Implement**

```ts
// server/utils/env.ts
import { z } from 'zod'

const encryptionKey = z
  .string({ error: 'STATESMAN_ENCRYPTION_KEY is required — run `pnpm gen:key`' })
  .transform((raw, ctx) => {
    let buf: Buffer
    try {
      buf = Buffer.from(raw, 'base64')
    } catch {
      ctx.addIssue({ code: 'custom', message: 'STATESMAN_ENCRYPTION_KEY must be base64' })
      return z.NEVER
    }
    if (buf.length !== 32) {
      ctx.addIssue({
        code: 'custom',
        message: `STATESMAN_ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}`
      })
      return z.NEVER
    }
    return buf
  })

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    DB_DRIVER: z.enum(['neon', 'node']).default('node'),
    STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
    STATESMAN_ENCRYPTION_KEY: encryptionKey,
    LOCAL_STORAGE_PATH: z.string().default('./.data/state'),
    S3_BUCKET: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().min(1),
    RETENTION_KEEP_VERSIONS: z.coerce.number().int().positive().default(100),
    RETENTION_KEEP_DAYS: z.coerce.number().int().positive().default(30),
    VERCEL: z.string().optional(),
    AWS_LAMBDA_FUNCTION_NAME: z.string().optional()
  })
  .superRefine((v, ctx) => {
    const serverless = Boolean(v.VERCEL ?? v.AWS_LAMBDA_FUNCTION_NAME)
    if (v.STORAGE_DRIVER === 'local' && serverless) {
      ctx.addIssue({
        code: 'custom',
        message:
          'STORAGE_DRIVER=local cannot run on a serverless platform: the filesystem is ephemeral and state would be lost on the next cold start. Use STORAGE_DRIVER=s3.'
      })
    }
    if (v.STORAGE_DRIVER === 's3' && !v.S3_BUCKET) {
      ctx.addIssue({ code: 'custom', message: 'S3_BUCKET is required when STORAGE_DRIVER=s3' })
    }
  })

export type Env = {
  DATABASE_URL: string
  DB_DRIVER: 'neon' | 'node'
  STORAGE_DRIVER: 's3' | 'local'
  ENCRYPTION_KEY: Buffer
  LOCAL_STORAGE_PATH: string
  S3_BUCKET?: string
  S3_ENDPOINT?: string
  S3_REGION: string
  S3_FORCE_PATH_STYLE: boolean
  S3_ACCESS_KEY_ID?: string
  S3_SECRET_ACCESS_KEY?: string
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL: string
  RETENTION_KEEP_VERSIONS: number
  RETENTION_KEEP_DAYS: number
  IS_SERVERLESS: boolean
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`).join('\n')
    throw new Error(`Invalid statesman configuration:\n${detail}`)
  }
  const v = parsed.data
  return {
    DATABASE_URL: v.DATABASE_URL,
    DB_DRIVER: v.DB_DRIVER,
    STORAGE_DRIVER: v.STORAGE_DRIVER,
    ENCRYPTION_KEY: v.STATESMAN_ENCRYPTION_KEY,
    LOCAL_STORAGE_PATH: v.LOCAL_STORAGE_PATH,
    S3_BUCKET: v.S3_BUCKET,
    S3_ENDPOINT: v.S3_ENDPOINT,
    S3_REGION: v.S3_REGION,
    S3_FORCE_PATH_STYLE: v.S3_FORCE_PATH_STYLE,
    S3_ACCESS_KEY_ID: v.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: v.S3_SECRET_ACCESS_KEY,
    BETTER_AUTH_SECRET: v.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: v.BETTER_AUTH_URL,
    RETENTION_KEEP_VERSIONS: v.RETENTION_KEEP_VERSIONS,
    RETENTION_KEEP_DAYS: v.RETENTION_KEEP_DAYS,
    IS_SERVERLESS: Boolean(v.VERCEL ?? v.AWS_LAMBDA_FUNCTION_NAME)
  }
}

let cached: Env | undefined
export function env(): Env {
  cached ??= loadEnv()
  return cached
}
```

- [x] **Step 5: Add the key generator**

```json
// package.json — scripts
"gen:key": "node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\""
```

- [x] **Step 6: Run tests and confirm they pass**

Run: `pnpm vitest run tests/unit/env.test.ts`
Expected: 5 passed.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold project with validated environment config"
```

---

### Task 0.2: Encryption

**Files:**
- Create: `server/utils/crypto.ts`
- Test: `tests/unit/crypto.test.ts`

**Interfaces:**
- Consumes: `Env.ENCRYPTION_KEY`
- Produces: `seal(key: Buffer, plaintext: Uint8Array): Buffer`, `open(key: Buffer, sealed: Uint8Array): Buffer`. Wire format: `[12-byte IV][16-byte GCM tag][ciphertext]`.

- [x] **Step 1: Write the failing test**

```ts
// tests/unit/crypto.test.ts
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { seal, open } from '../../server/utils/crypto'

const key = randomBytes(32)

describe('crypto', () => {
  it('round-trips a payload', () => {
    const plain = Buffer.from(JSON.stringify({ version: 4, serial: 1 }))
    expect(open(key, seal(key, plain))).toEqual(plain)
  })

  it('produces different ciphertext for identical input', () => {
    const plain = Buffer.from('same')
    expect(seal(key, plain).equals(seal(key, plain))).toBe(false)
  })

  it('rejects a tampered payload', () => {
    const sealed = seal(key, Buffer.from('secret'))
    sealed[sealed.length - 1] ^= 0xff
    expect(() => open(key, sealed)).toThrow()
  })

  it('rejects the wrong key', () => {
    const sealed = seal(key, Buffer.from('secret'))
    expect(() => open(randomBytes(32), sealed)).toThrow()
  })

  it('handles an empty payload', () => {
    expect(open(key, seal(key, Buffer.alloc(0)))).toHaveLength(0)
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/unit/crypto.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

```ts
// server/utils/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

export function seal(key: Buffer, plaintext: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

export function open(key: Buffer, sealed: Uint8Array): Buffer {
  const buf = Buffer.from(sealed)
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error('ciphertext too short to be valid')
  }
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}
```

- [x] **Step 4: Run tests and confirm they pass**

Run: `pnpm vitest run tests/unit/crypto.test.ts`
Expected: 5 passed.

- [x] **Step 5: Commit**

```bash
git add server/utils/crypto.ts tests/unit/crypto.test.ts
git commit -m "feat: add AES-256-GCM sealing for state at rest"
```

---

### Task 0.3: Database schema and driver switch

**Files:**
- Create: `server/db/schema.ts`, `server/db/client.ts`, `drizzle.config.ts`
- Test: `tests/integration/db.test.ts`

**Interfaces:**
- Consumes: `env()`
- Produces: tables `organization`, `project`, `stateVersion`, `projectState`, `stateLock`, `auditLog`, plus Better Auth's `user`, `session`, `account`, `verification`, `apikey`. Exports `db()` returning a Drizzle instance typed against the full schema.

- [x] **Step 1: Write the failing test**

```ts
// tests/integration/db.test.ts
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
```

- [x] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/integration/db.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the schema**

```ts
// server/db/schema.ts
import {
  pgTable, text, timestamp, integer, bigint, boolean, jsonb, uniqueIndex, index
} from 'drizzle-orm/pg-core'

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const apikey = pgTable('apikey', {
  id: text('id').primaryKey(),
  name: text('name'),
  start: text('start'),
  prefix: text('prefix'),
  key: text('key').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  refillInterval: integer('refill_interval'),
  refillAmount: integer('refill_amount'),
  lastRefillAt: timestamp('last_refill_at'),
  enabled: boolean('enabled').notNull().default(true),
  rateLimitEnabled: boolean('rate_limit_enabled').notNull().default(false),
  rateLimitTimeWindow: integer('rate_limit_time_window'),
  rateLimitMax: integer('rate_limit_max'),
  requestCount: integer('request_count').notNull().default(0),
  remaining: integer('remaining'),
  lastRequest: timestamp('last_request'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  permissions: text('permissions'),
  metadata: text('metadata')
})

export const organization = pgTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow()
})

export const project = pgTable(
  'project',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow()
  },
  (t) => [uniqueIndex('project_org_slug_uq').on(t.orgId, t.slug)]
)

export const stateVersion = pgTable(
  'state_version',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => project.id, { onDelete: 'cascade' }),
    serial: bigint('serial', { mode: 'number' }),
    lineage: text('lineage'),
    sizeBytes: integer('size_bytes').notNull(),
    md5: text('md5').notNull(),
    blobKey: text('blob_key').notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow()
  },
  (t) => [index('state_version_project_created_idx').on(t.projectId, t.createdAt)]
)

export const projectState = pgTable('project_state', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => project.id, { onDelete: 'cascade' }),
  currentVersionId: text('current_version_id')
    .notNull()
    .references(() => stateVersion.id, { onDelete: 'restrict' }),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const stateLock = pgTable('state_lock', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => project.id, { onDelete: 'cascade' }),
  lockId: text('lock_id').notNull(),
  who: text('who'),
  operation: text('operation'),
  version: text('version'),
  infoJson: jsonb('info_json').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow()
})

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    projectId: text('project_id'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    metaJson: jsonb('meta_json'),
    at: timestamp('at').notNull().defaultNow()
  },
  (t) => [index('audit_log_project_at_idx').on(t.projectId, t.at)]
)

export const schema = {
  user, session, account, verification, apikey,
  organization, project, stateVersion, projectState, stateLock, auditLog
}
```

- [x] **Step 4: Implement the driver switch**

```ts
// server/db/client.ts
import { drizzle as drizzleNode, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { drizzle as drizzleNeon, type NeonHttpDatabase } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import { Pool } from 'pg'
import { env } from '../utils/env'
import { schema } from './schema'

type Schema = typeof schema
export type Database = NodePgDatabase<Schema> | NeonHttpDatabase<Schema>

let instance: Database | undefined

export function db(): Database {
  if (instance) return instance
  const config = env()
  instance =
    config.DB_DRIVER === 'neon'
      ? drizzleNeon(neon(config.DATABASE_URL), { schema })
      : drizzleNode(new Pool({ connectionString: config.DATABASE_URL }), { schema })
  return instance
}
```

Both branches expose the same query builder for everything this project uses. Neon's HTTP driver does not support interactive transactions; no code path in this project requires one, because the lock is a single atomic `INSERT ... ON CONFLICT` rather than a read-then-write.

- [x] **Step 5: Create the development database**

Task C1 writes the full compose stack, but Phase 0 needs Postgres now. Create the
minimum here and let C1 extend it:

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: statesman
      POSTGRES_PASSWORD: statesman
      POSTGRES_DB: statesman
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U statesman']
      interval: 5s
      timeout: 5s
      retries: 10

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports: ['9000:9000', '9001:9001']
    volumes: ['miniodata:/data']

volumes:
  pgdata:
  miniodata:
```

- [x] **Step 6: Generate and apply migrations**

```bash
docker compose up -d postgres
pnpm drizzle-kit generate
pnpm drizzle-kit migrate
```

- [x] **Step 7: Run tests and confirm they pass**

Run: `pnpm vitest run tests/integration/db.test.ts`
Expected: 2 passed.

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add drizzle schema and dual-driver database client"
```

---

### Task 0.4: Storage adapters

**Files:**
- Create: `server/storage/types.ts`, `server/storage/local.ts`, `server/storage/s3.ts`, `server/storage/index.ts`
- Test: `tests/integration/storage.conformance.ts`, `tests/integration/storage.test.ts`

**Interfaces:**
- Consumes: `env()`
- Produces: `interface StateStore { put(key, data): Promise<void>; get(key): Promise<Uint8Array | null>; delete(key): Promise<void>; list(prefix): Promise<string[]> }` and `store(): StateStore`. `get` returns `null` for a missing key — it never throws for absence.

- [x] **Step 1: Write the shared conformance suite**

```ts
// tests/integration/storage.conformance.ts
import { describe, it, expect } from 'vitest'
import type { StateStore } from '../../server/storage/types'

export function conformsToStateStore(name: string, make: () => Promise<StateStore>) {
  describe(`StateStore conformance: ${name}`, () => {
    it('returns null for a missing key', async () => {
      expect(await (await make()).get('nope/missing.bin')).toBeNull()
    })

    it('round-trips bytes', async () => {
      const s = await make()
      const data = new Uint8Array([1, 2, 3, 250, 0, 128])
      await s.put('a/b.bin', data)
      expect(Buffer.from((await s.get('a/b.bin'))!)).toEqual(Buffer.from(data))
    })

    it('lists by prefix and excludes other prefixes', async () => {
      const s = await make()
      await s.put('p1/one.bin', new Uint8Array([1]))
      await s.put('p1/two.bin', new Uint8Array([2]))
      await s.put('p2/three.bin', new Uint8Array([3]))
      const keys = (await s.list('p1/')).sort()
      expect(keys).toEqual(['p1/one.bin', 'p1/two.bin'])
    })

    it('deletes a key', async () => {
      const s = await make()
      await s.put('gone.bin', new Uint8Array([9]))
      await s.delete('gone.bin')
      expect(await s.get('gone.bin')).toBeNull()
    })

    it('deleting a missing key is not an error', async () => {
      await expect((await make()).delete('never/existed.bin')).resolves.toBeUndefined()
    })

    it('handles a large payload', async () => {
      const s = await make()
      const big = new Uint8Array(5 * 1024 * 1024).fill(42)
      await s.put('big.bin', big)
      expect((await s.get('big.bin'))!.length).toBe(big.length)
    })
  })
}
```

- [x] **Step 2: Wire both drivers into the suite**

```ts
// tests/integration/storage.test.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { conformsToStateStore } from './storage.conformance'
import { LocalStore } from '../../server/storage/local'
import { S3Store } from '../../server/storage/s3'

const dirs: string[] = []
conformsToStateStore('local', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statesman-'))
  dirs.push(dir)
  return new LocalStore(dir)
})
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

// Requires MinIO from docker-compose.yml
conformsToStateStore('s3 (minio)', async () =>
  new S3Store({
    bucket: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    createBucketIfMissing: true
  })
)
```

- [x] **Step 3: Run and confirm both fail**

Run: `pnpm vitest run tests/integration/storage.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 4: Implement the interface and local driver**

```ts
// server/storage/types.ts
export interface StateStore {
  put(key: string, data: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}
```

```ts
// server/storage/local.ts
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { dirname, join, resolve, relative, sep } from 'node:path'
import type { StateStore } from './types'

export class LocalStore implements StateStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const full = resolve(this.root, key)
    const rel = relative(resolve(this.root), full)
    if (rel.startsWith('..') || rel.startsWith(sep)) {
      throw new Error(`refusing to access a path outside the storage root: ${key}`)
    }
    return full
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const file = this.path(key)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, data)
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(key)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true })
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else {
          const key = relative(resolve(this.root), full).split(sep).join('/')
          if (key.startsWith(prefix)) out.push(key)
        }
      }
    }
    await walk(resolve(this.root))
    return out
  }
}
```

- [x] **Step 5: Implement the S3 driver**

```ts
// server/storage/s3.ts
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  ListObjectsV2Command, CreateBucketCommand, HeadBucketCommand
} from '@aws-sdk/client-s3'
import type { StateStore } from './types'

export type S3StoreOptions = {
  bucket: string
  region: string
  endpoint?: string
  forcePathStyle?: boolean
  accessKeyId?: string
  secretAccessKey?: string
  createBucketIfMissing?: boolean
}

export class S3Store implements StateStore {
  private readonly client: S3Client
  private readonly bucket: string
  private ready: Promise<void> | undefined

  constructor(private readonly options: S3StoreOptions) {
    this.bucket = options.bucket
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
          : undefined
    })
  }

  private async ensureBucket(): Promise<void> {
    if (!this.options.createBucketIfMissing) return
    this.ready ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
      } catch {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }))
      }
    })()
    return this.ready
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.ensureBucket()
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data })
    )
  }

  async get(key: string): Promise<Uint8Array | null> {
    await this.ensureBucket()
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      )
      const bytes = await result.Body?.transformToByteArray()
      return bytes ?? null
    } catch (error) {
      const name = (error as { name?: string }).name
      if (name === 'NoSuchKey' || name === 'NotFound') return null
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.ensureBucket()
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async list(prefix: string): Promise<string[]> {
    await this.ensureBucket()
    const keys: string[] = []
    let token: string | undefined
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      )
      for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key)
      token = page.NextContinuationToken
    } while (token)
    return keys
  }
}
```

- [x] **Step 6: Implement the switch**

```ts
// server/storage/index.ts
import { env } from '../utils/env'
import { LocalStore } from './local'
import { S3Store } from './s3'
import type { StateStore } from './types'

let instance: StateStore | undefined

export function store(): StateStore {
  if (instance) return instance
  const config = env()
  instance =
    config.STORAGE_DRIVER === 's3'
      ? new S3Store({
          bucket: config.S3_BUCKET!,
          region: config.S3_REGION,
          endpoint: config.S3_ENDPOINT,
          forcePathStyle: config.S3_FORCE_PATH_STYLE,
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY
        })
      : new LocalStore(config.LOCAL_STORAGE_PATH)
  return instance
}

export type { StateStore } from './types'
```

`config.S3_BUCKET!` is safe here and only here: `loadEnv` rejects `STORAGE_DRIVER=s3` without a bucket, so this branch is unreachable with an undefined bucket.

- [x] **Step 7: Run tests and confirm they pass**

Run: `docker compose up -d minio && pnpm vitest run tests/integration/storage.test.ts`
Expected: 12 passed (6 conformance tests × 2 drivers).

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add local and s3 state storage adapters with shared conformance suite"
```

---

### Task 0.5: Better Auth with the API Key plugin

**Files:**
- Create: `server/utils/auth.ts`, `server/api/auth/[...all].ts`
- Test: `tests/integration/auth.test.ts`

**Interfaces:**
- Consumes: `db()`, `env()`
- Produces: `auth` — a Better Auth instance with `emailAndPassword` and the `apiKey` plugin. Server calls used downstream: `auth.api.createApiKey`, `auth.api.verifyApiKey`, `auth.api.listApiKeys`, `auth.api.deleteApiKey`, `auth.api.getSession`.

- [x] **Step 1: Write the failing test**

```ts
// tests/integration/auth.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { auth } from '../../server/utils/auth'

let userId: string

describe('api keys', () => {
  beforeAll(async () => {
    const created = await auth.api.signUpEmail({
      body: { email: `t${Date.now()}@example.com`, password: 'correct horse battery', name: 'T' }
    })
    userId = created.user.id
  })

  it('verifies a freshly created key', async () => {
    const key = await auth.api.createApiKey({
      body: { userId, name: 'ci', permissions: { state: ['read', 'write'] },
              metadata: { projects: ['acme/prod'] } }
    })
    const result = await auth.api.verifyApiKey({ body: { key: key.key } })
    expect(result.valid).toBe(true)
    expect(result.key?.id).toBe(key.id)
  })

  it('rejects a key that does not exist', async () => {
    const result = await auth.api.verifyApiKey({ body: { key: 'sm_not_a_real_key' } })
    expect(result.valid).toBe(false)
  })

  it('enforces declared permissions', async () => {
    const key = await auth.api.createApiKey({
      body: { userId, name: 'read-only', permissions: { state: ['read'] } }
    })
    const ok = await auth.api.verifyApiKey({
      body: { key: key.key, permissions: { state: ['read'] } }
    })
    const denied = await auth.api.verifyApiKey({
      body: { key: key.key, permissions: { state: ['write'] } }
    })
    expect(ok.valid).toBe(true)
    expect(denied.valid).toBe(false)
  })

  it('rejects a disabled key', async () => {
    const key = await auth.api.createApiKey({ body: { userId, name: 'off' } })
    await auth.api.updateApiKey({ body: { keyId: key.id, userId, enabled: false } })
    expect((await auth.api.verifyApiKey({ body: { key: key.key } })).valid).toBe(false)
  })

  it('round-trips project scope through metadata', async () => {
    const key = await auth.api.createApiKey({
      body: { userId, name: 'scoped', metadata: { projects: ['acme/prod', 'acme/staging'] } }
    })
    const result = await auth.api.verifyApiKey({ body: { key: key.key } })
    expect(result.key?.metadata).toMatchObject({ projects: ['acme/prod', 'acme/staging'] })
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/integration/auth.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

```ts
// server/utils/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { apiKey } from 'better-auth/plugins'
import { db } from '../db/client'
import { schema } from '../db/schema'
import { env } from './env'

export const auth = betterAuth({
  secret: env().BETTER_AUTH_SECRET,
  baseURL: env().BETTER_AUTH_URL,
  database: drizzleAdapter(db(), { provider: 'pg', schema }),
  emailAndPassword: { enabled: true },
  plugins: [
    apiKey({
      defaultPrefix: 'sm_',
      enableMetadata: true,
      permissions: { defaultPermissions: { state: ['read'] } }
    })
  ]
})

export type Auth = typeof auth
```

```ts
// server/api/auth/[...all].ts
import { auth } from '../../utils/auth'

export default defineEventHandler((event) => auth.handler(toWebRequest(event)))
```

- [x] **Step 4: Run tests and confirm they pass**

Run: `pnpm vitest run tests/integration/auth.test.ts`
Expected: 5 passed.

If `enableMetadata` or the permissions option name differs in 1.7.2, consult the live docs at https://better-auth.com/docs/plugins/api-key and adjust — the tests define the required behaviour, not the option spelling.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: configure better auth with the api key plugin"
```

---

### Task 0.6: Shared Zod schemas

**Files:**
- Create: `shared/schemas/lock.ts`, `shared/schemas/token.ts`, `shared/schemas/project.ts`, `shared/types.ts`
- Test: `tests/unit/schemas.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `lockInfoSchema` / `LockInfo`, `tokenConfigSchema` / `TokenConfig`, `projectRefSchema` / `ProjectRef`, `stateActionSchema` / `StateAction`. **Both lanes import from here.** Lane B's token form and Lane A's guard use the same `tokenConfigSchema`.

- [x] **Step 1: Write the failing test**

```ts
// tests/unit/schemas.test.ts
import { describe, it, expect } from 'vitest'
import { lockInfoSchema } from '../../shared/schemas/lock'
import { tokenConfigSchema } from '../../shared/schemas/token'
import { projectRefSchema } from '../../shared/schemas/project'

describe('lockInfoSchema', () => {
  it('accepts what terraform actually sends', () => {
    const parsed = lockInfoSchema.parse({
      ID: '90f1e2d3-0000-4000-8000-000000000000',
      Operation: 'OperationTypeApply',
      Info: '',
      Who: 'jj@laptop',
      Version: '1.9.5',
      Created: '2026-09-04T10:00:00.123456Z',
      Path: ''
    })
    expect(parsed.ID).toBe('90f1e2d3-0000-4000-8000-000000000000')
  })

  it('requires an ID', () => {
    expect(() => lockInfoSchema.parse({ Who: 'jj' })).toThrow()
  })

  it('tolerates absent optional fields', () => {
    expect(lockInfoSchema.parse({ ID: 'abc' }).Who).toBeUndefined()
  })
})

describe('tokenConfigSchema', () => {
  it('accepts a scoped token', () => {
    const parsed = tokenConfigSchema.parse({
      name: 'ci-prod',
      actions: ['read', 'write', 'lock'],
      scope: { kind: 'projects', projects: ['acme/prod'] },
      expiresInDays: 90
    })
    expect(parsed.scope.kind).toBe('projects')
  })

  it('accepts an account-wide token', () => {
    expect(tokenConfigSchema.parse({
      name: 'all', actions: ['read'], scope: { kind: 'all' }
    }).scope.kind).toBe('all')
  })

  it('rejects a projects scope with an empty list', () => {
    expect(() => tokenConfigSchema.parse({
      name: 'bad', actions: ['read'], scope: { kind: 'projects', projects: [] }
    })).toThrow()
  })

  it('rejects an unknown action', () => {
    expect(() => tokenConfigSchema.parse({
      name: 'bad', actions: ['sudo'], scope: { kind: 'all' }
    })).toThrow()
  })

  it('rejects an empty name', () => {
    expect(() => tokenConfigSchema.parse({
      name: '', actions: ['read'], scope: { kind: 'all' }
    })).toThrow()
  })
})

describe('projectRefSchema', () => {
  it('accepts a well-formed slug pair', () => {
    expect(projectRefSchema.parse({ org: 'acme', project: 'my-app-prod' }).org).toBe('acme')
  })

  it('rejects path traversal in a slug', () => {
    expect(() => projectRefSchema.parse({ org: '..', project: 'x' })).toThrow()
    expect(() => projectRefSchema.parse({ org: 'a', project: 'a/b' })).toThrow()
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/unit/schemas.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement**

```ts
// shared/schemas/lock.ts
import { z } from 'zod'

// Shape is defined by Terraform's statemgr.LockInfo. Every field except ID is
// best-effort: older CLI versions and third-party tooling omit some of them.
export const lockInfoSchema = z.object({
  ID: z.string().min(1),
  Operation: z.string().optional(),
  Info: z.string().optional(),
  Who: z.string().optional(),
  Version: z.string().optional(),
  Created: z.string().optional(),
  Path: z.string().optional()
})

export type LockInfo = z.infer<typeof lockInfoSchema>
```

```ts
// shared/schemas/project.ts
import { z } from 'zod'

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase letters, digits and dashes')

export const projectRefSchema = z.object({ org: slug, project: slug })
export type ProjectRef = z.infer<typeof projectRefSchema>

export const projectSlug = slug
```

```ts
// shared/schemas/token.ts
import { z } from 'zod'

export const stateActionSchema = z.enum(['read', 'write', 'delete', 'lock'])
export type StateAction = z.infer<typeof stateActionSchema>

export const tokenScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({
    kind: z.literal('projects'),
    projects: z.array(z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/)).min(1)
  })
])
export type TokenScope = z.infer<typeof tokenScopeSchema>

export const tokenConfigSchema = z.object({
  name: z.string().min(1).max(64),
  actions: z.array(stateActionSchema).min(1),
  scope: tokenScopeSchema,
  expiresInDays: z.number().int().positive().max(3650).optional(),
  rateLimitMax: z.number().int().positive().optional(),
  rateLimitWindowSeconds: z.number().int().positive().optional()
})
export type TokenConfig = z.infer<typeof tokenConfigSchema>
```

```ts
// shared/types.ts
export type { LockInfo } from './schemas/lock'
export type { ProjectRef } from './schemas/project'
export type { TokenConfig, TokenScope, StateAction } from './schemas/token'
```

- [x] **Step 4: Run tests and confirm they pass**

Run: `pnpm vitest run tests/unit/schemas.test.ts`
Expected: 11 passed.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add zod schemas shared between the protocol and dashboard"
```

---

### Task 0.7: Nuxt UI base and design tokens

**Files:**
- Create: `app.config.ts`, `app/assets/css/main.css`, `app/app.vue`
- Modify: `nuxt.config.ts`
- Test: `tests/unit/boot.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: the semantic color mapping every Lane B component relies on.

- [x] **Step 1: Write the failing test**

```ts
// tests/unit/boot.test.ts
import { describe, it, expect } from 'vitest'
import appConfig from '../../app.config'

describe('design tokens', () => {
  it('maps all seven semantic colors', () => {
    const colors = appConfig.ui?.colors ?? {}
    for (const name of ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral']) {
      expect(colors, `missing semantic color: ${name}`).toHaveProperty(name)
    }
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/unit/boot.test.ts`
Expected: FAIL — `app.config` not found.

- [x] **Step 3: Implement**

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'indigo',
      secondary: 'violet',
      success: 'emerald',
      info: 'sky',
      warning: 'amber',
      error: 'rose',
      neutral: 'zinc'
    }
  }
})
```

`zinc` for neutral and `indigo` for primary read as infrastructure tooling rather than consumer product — cool, low-saturation, and legible in both color modes. `rose` for error keeps destructive actions distinct from the `amber` lock-held warning, which matters because both appear on the project page at once.

```css
/* app/assets/css/main.css */
@import "tailwindcss";
@import "@nuxt/ui";

:root { color-scheme: light dark; }

/* Numeric columns in the version timeline must not jitter between rows. */
.tabular { font-variant-numeric: tabular-nums; }
```

```vue
<!-- app/app.vue -->
<template>
  <UApp>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: '2026-09-04',
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  colorMode: { preference: 'system', fallback: 'dark' },
  app: {
    head: {
      title: 'statesman',
      meta: [
        { name: 'theme-color', content: '#18181b', media: '(prefers-color-scheme: dark)' },
        { name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' }
      ]
    }
  },
  typescript: { strict: true, typeCheck: true }
})
```

Do not add `@nuxt/icon`, `@nuxt/fonts`, or `@nuxtjs/color-mode` to `modules` — Nuxt UI registers all three, and listing them again breaks the build.

- [x] **Step 4: Run tests and confirm they pass**

Run: `pnpm vitest run tests/unit/boot.test.ts && pnpm nuxt build`
Expected: 1 passed; build succeeds.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add nuxt ui base configuration and design tokens"
```

---

### Task 0.8: Startup health checks

Implements spec §10b. Tier 1 (config) already exists from the Phase 0 fix round; this
task adds Tier 2 (connectivity) and the health endpoint.

**Files:**
- Create: `server/utils/health.ts`, `server/api/health.get.ts`
- Modify: `server/plugins/00.env.ts`
- Modify: `docker-compose.prod.yml` (add the app healthcheck — Task C3 creates the file; if it does not exist yet, note it for C3 instead)
- Test: `tests/integration/health.test.ts`

**Interfaces:**
- Consumes: `env()`, `db()`, `store()`, `seal`/`open`
- Produces:
  ```ts
  type CheckName = 'encryption' | 'database' | 'migrations' | 'storage'
  type CheckResult = { name: CheckName; ok: boolean; detail?: string; ms: number }
  async function runHealthChecks(): Promise<{ ok: boolean; checks: CheckResult[] }>
  async function assertHealthy(): Promise<void>   // throws on a long-running server; no-op on serverless
  ```

- [x] **Step 1: Write the failing test**

```ts
// tests/integration/health.test.ts
import { describe, it, expect } from 'vitest'
import { runHealthChecks } from '../../server/utils/health'
import { store } from '../../server/storage'

describe('health checks', () => {
  it('passes with a correctly configured environment', async () => {
    const result = await runHealthChecks()
    expect(result.checks.map((c) => c.name).sort())
      .toEqual(['database', 'encryption', 'migrations', 'storage'])
    expect(result.ok, JSON.stringify(result.checks)).toBe(true)
  })

  it('times every check', async () => {
    const result = await runHealthChecks()
    for (const check of result.checks) expect(check.ms).toBeGreaterThanOrEqual(0)
  })

  it('leaves no probe object behind', async () => {
    await runHealthChecks()
    expect(await store().list('.statesman-healthcheck/')).toHaveLength(0)
  })

  it('reports a failing check by name without leaking configuration', async () => {
    // Point storage at an unwritable location and confirm the failure is named,
    // and that the detail does not contain the path, bucket or credentials.
    const result = await runHealthChecksAgainst({ breakStorage: true })
    const storage = result.checks.find((c) => c.name === 'storage')
    expect(result.ok).toBe(false)
    expect(storage?.ok).toBe(false)
    expect(storage?.detail ?? '').not.toMatch(/secret|password|key|\/Users\//i)
  })
})
```

`runHealthChecksAgainst` is a test-only seam; implement it however keeps production
code clean — an optional injected `StateStore` is the obvious shape. If injecting
turns out to complicate the production signature, drop this fourth test and instead
prove the same property with a direct unit test of the error-redaction helper. Say
which you chose.

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/integration/health.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the checks**

```ts
// server/utils/health.ts
import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { store } from '../storage'
import { seal, open } from './crypto'
import { env } from './env'

export type CheckName = 'encryption' | 'database' | 'migrations' | 'storage'
export type CheckResult = { name: CheckName; ok: boolean; detail?: string; ms: number }

const PROBE_PREFIX = '.statesman-healthcheck/'

// The health endpoint is unauthenticated, so a failure detail must never carry a
// connection string, bucket name, filesystem path or key material.
function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0]!.slice(0, 120).replace(/[a-z]+:\/\/[^\s]+/gi, '<redacted-url>')
}

async function timed(name: CheckName, fn: () => Promise<void>): Promise<CheckResult> {
  const started = Date.now()
  try {
    await fn()
    return { name, ok: true, ms: Date.now() - started }
  } catch (error) {
    return { name, ok: false, detail: redact(error), ms: Date.now() - started }
  }
}

export async function runHealthChecks(): Promise<{ ok: boolean; checks: CheckResult[] }> {
  const checks = [
    await timed('encryption', async () => {
      const probe = randomBytes(32)
      const roundTripped = open(env().ENCRYPTION_KEY, seal(env().ENCRYPTION_KEY, probe))
      if (!roundTripped.equals(probe)) throw new Error('encryption round-trip mismatch')
    }),
    await timed('database', async () => {
      await db().execute(sql`select 1`)
    }),
    await timed('migrations', async () => {
      const rows = await db().execute<{ present: boolean }>(
        sql`select to_regclass('public.organization') is not null as present`
      )
      const present = (rows as unknown as { rows?: { present: boolean }[] }).rows?.[0]?.present
        ?? (rows as unknown as { present: boolean }[])[0]?.present
      if (!present) throw new Error('migrations have not been applied')
    }),
    await timed('storage', async () => {
      // Put, get AND delete. A read-only probe passes for credentials that can
      // list but not write — the exact failure that surfaces on the first apply
      // rather than at deploy time.
      const key = `${PROBE_PREFIX}${ulid()}`
      const payload = randomBytes(16)
      await store().put(key, payload)
      const readBack = await store().get(key)
      await store().delete(key)
      if (!readBack || !Buffer.from(readBack).equals(payload)) {
        throw new Error('storage round-trip mismatch')
      }
    })
  ]
  return { ok: checks.every((c) => c.ok), checks }
}

export async function assertHealthy(): Promise<void> {
  // Serverless functions cold-start constantly and Neon scales to zero. Probing
  // the database on every cold start would add latency to every request path and
  // turn a brief upstream blip into a hard outage. /api/health still reports on
  // demand.
  if (env().IS_SERVERLESS) return

  const result = await runHealthChecks()
  if (result.ok) return

  const failed = result.checks.filter((c) => !c.ok)
  throw new Error(
    `statesman startup checks failed:\n${failed.map((c) => `  - ${c.name}: ${c.detail}`).join('\n')}`
  )
}
```

`db().execute` result shapes differ between the `pg` and Neon drivers — one returns
`{ rows }`, the other an array. The `migrations` check handles both. Verify against
both drivers rather than trusting the shape above.

- [x] **Step 4: Wire it into startup**

```ts
// server/plugins/00.env.ts
import { assertEnvironment } from '../utils/env-guard'
import { assertHealthy } from '../utils/health'

export default defineNitroPlugin(async () => {
  // Tier 1: configuration. Deterministic, so always fatal.
  assertEnvironment()
  // Tier 2: connectivity. Fatal on a long-running server, skipped on serverless.
  await assertHealthy()
})
```

Keep the existing `assertEnvironment` export and its tests exactly as they are.

- [x] **Step 5: Add the endpoint**

```ts
// server/api/health.get.ts
import { runHealthChecks } from '../utils/health'

export default defineEventHandler(async (event) => {
  const result = await runHealthChecks()
  if (!result.ok) setResponseStatus(event, 503)
  return { status: result.ok ? 'ok' : 'degraded', checks: result.checks }
})
```

Unauthenticated by design — a load balancer cannot hold a session. It returns check
names and pass/fail only.

- [x] **Step 6: Run tests and confirm they pass**

Run: `pnpm vitest run tests/integration/health.test.ts`
Then prove the startup path really fails, against the built server rather than a unit
test — stop Postgres and confirm the process exits non-zero:

```bash
pnpm build
docker compose stop postgres
node .output/server/index.mjs; echo "EXIT=$?"    # expect non-zero, naming 'database'
docker compose start postgres
```

- [x] **Step 7: Commit**

```bash
git add server/utils/health.ts server/api/health.get.ts server/plugins/00.env.ts tests/integration/health.test.ts
git commit -m "feat: add startup connectivity checks and health endpoint"
```

---

## Phase 0 exit gate

All of these must hold before either lane starts (Tasks 0.1 through 0.8):

```bash
pnpm vitest run          # every Phase 0 test passes
pnpm nuxt build          # builds clean
pnpm vue-tsc --noEmit    # no type errors, no `any`
```

Then tag the contract so both lanes branch from an identical base:

```bash
git tag phase-0-complete
```

---

# LANE A — Terraform Protocol

**Runs in parallel with Lane B.** Agent owns `server/utils/tf-auth.ts`, `server/services/**`, `server/api/tf/**`, `tests/protocol/**`. Touches nothing else.

---

### Task A1: Terraform request authorization

**Files:**
- Create: `server/utils/tf-auth.ts`
- Test: `tests/protocol/tf-auth.test.ts`

**Interfaces:**
- Consumes: `auth` (0.5), `tokenConfigSchema`/`StateAction` (0.6), `projectRefSchema` (0.6)
- Produces:
  ```ts
  type TfPrincipal = { userId: string; keyId: string; actions: StateAction[]; scope: TokenScope }
  function parseBasicAuth(header: string | undefined): string | null
  function scopeAllows(scope: TokenScope, org: string, project: string): boolean
  async function authorizeTf(event: H3Event, ref: ProjectRef, action: StateAction): Promise<TfPrincipal>
  ```
  `authorizeTf` throws `createError({ statusCode })` — 401 for bad credentials, 403 for scope or permission failure.

This is the security-critical guard named in the spec (§4). Every `/api/tf/*` handler calls it. It is never re-implemented per route.

- [x] **Step 1: Write the failing test**

```ts
// tests/protocol/tf-auth.test.ts
import { describe, it, expect } from 'vitest'
import { parseBasicAuth, scopeAllows } from '../../server/utils/tf-auth'

describe('parseBasicAuth', () => {
  it('extracts the password, ignoring the username', () => {
    const header = `Basic ${Buffer.from('statesman:sm_secret').toString('base64')}`
    expect(parseBasicAuth(header)).toBe('sm_secret')
  })

  it('handles a password containing colons', () => {
    const header = `Basic ${Buffer.from('u:a:b:c').toString('base64')}`
    expect(parseBasicAuth(header)).toBe('a:b:c')
  })

  it('returns null for a missing header', () => {
    expect(parseBasicAuth(undefined)).toBeNull()
  })

  it('returns null for a non-Basic scheme', () => {
    expect(parseBasicAuth('Bearer sm_secret')).toBeNull()
  })

  it('returns null for an empty password', () => {
    expect(parseBasicAuth(`Basic ${Buffer.from('user:').toString('base64')}`)).toBeNull()
  })

  it('returns null for undecodable base64', () => {
    expect(parseBasicAuth('Basic !!!not-base64!!!')).toBeNull()
  })
})

describe('scopeAllows', () => {
  it('allows any project for an account-wide scope', () => {
    expect(scopeAllows({ kind: 'all' }, 'acme', 'prod')).toBe(true)
  })

  it('allows a listed project', () => {
    const scope = { kind: 'projects', projects: ['acme/prod'] } as const
    expect(scopeAllows(scope, 'acme', 'prod')).toBe(true)
  })

  it('denies an unlisted project', () => {
    const scope = { kind: 'projects', projects: ['acme/prod'] } as const
    expect(scopeAllows(scope, 'acme', 'staging')).toBe(false)
  })

  it('denies a matching project name in a different org', () => {
    const scope = { kind: 'projects', projects: ['acme/prod'] } as const
    expect(scopeAllows(scope, 'evil', 'prod')).toBe(false)
  })

  it('denies on a prefix near-match', () => {
    const scope = { kind: 'projects', projects: ['acme/prod'] } as const
    expect(scopeAllows(scope, 'acme', 'prod-2')).toBe(false)
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/protocol/tf-auth.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

```ts
// server/utils/tf-auth.ts
import type { H3Event } from 'h3'
import { auth } from './auth'
import { tokenScopeSchema, type StateAction, type TokenScope } from '../../shared/schemas/token'
import type { ProjectRef } from '../../shared/schemas/project'

export type TfPrincipal = {
  userId: string
  keyId: string
  actions: StateAction[]
  scope: TokenScope
}

export function parseBasicAuth(header: string | undefined): string | null {
  if (!header?.startsWith('Basic ')) return null
  let decoded: string
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  } catch {
    return null
  }
  const separator = decoded.indexOf(':')
  if (separator === -1) return null
  const password = decoded.slice(separator + 1)
  return password.length > 0 ? password : null
}

export function scopeAllows(scope: TokenScope, org: string, project: string): boolean {
  if (scope.kind === 'all') return true
  return scope.projects.includes(`${org}/${project}`)
}

export async function authorizeTf(
  event: H3Event,
  ref: ProjectRef,
  action: StateAction
): Promise<TfPrincipal> {
  const key = parseBasicAuth(getRequestHeader(event, 'authorization'))
  if (!key) {
    setResponseHeader(event, 'WWW-Authenticate', 'Basic realm="statesman"')
    throw createError({ statusCode: 401, statusMessage: 'Missing or malformed credentials' })
  }

  const result = await auth.api.verifyApiKey({ body: { key, permissions: { state: [action] } } })
  if (!result.valid || !result.key) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid API key' })
  }

  const rawMetadata = result.key.metadata
  const metadata = typeof rawMetadata === 'string'
    ? (JSON.parse(rawMetadata) as unknown)
    : (rawMetadata as unknown)
  const parsedScope = tokenScopeSchema.safeParse(
    (metadata as { scope?: unknown } | null)?.scope
  )
  // A key with no recorded scope grants nothing. Failing closed is the only
  // safe reading of missing authorization data.
  const scope: TokenScope = parsedScope.success ? parsedScope.data : { kind: 'projects', projects: [] }

  if (!scopeAllows(scope, ref.org, ref.project)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Token is not scoped to ${ref.org}/${ref.project}`
    })
  }

  const permissions = result.key.permissions as { state?: string[] } | null
  const actions = (permissions?.state ?? []) as StateAction[]

  return { userId: result.key.userId, keyId: result.key.id, actions, scope }
}
```

- [x] **Step 4: Run tests and confirm they pass**

Run: `pnpm vitest run tests/protocol/tf-auth.test.ts`
Expected: 11 passed.

- [x] **Step 5: Commit**

```bash
git add server/utils/tf-auth.ts tests/protocol/tf-auth.test.ts
git commit -m "feat: add terraform request authorization guard"
```

---

### Task A2: Lock service

**Files:**
- Create: `server/services/lock.ts`
- Test: `tests/protocol/lock.test.ts`

**Interfaces:**
- Consumes: `db()`, `stateLock` (0.3), `LockInfo` (0.6)
- Produces:
  ```ts
  type AcquireResult =
    | { ok: true }
    | { ok: false; held: LockInfo }
  async function acquireLock(projectId: string, info: LockInfo): Promise<AcquireResult>
  async function releaseLock(projectId: string, lockId: string): Promise<boolean>
  async function forceReleaseLock(projectId: string): Promise<void>
  async function currentLock(projectId: string): Promise<LockInfo | null>
  ```
  `releaseLock` returns `false` when the supplied `lockId` does not match the held lock.

- [x] **Step 1: Write the failing test**

```ts
// tests/protocol/lock.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { acquireLock, releaseLock, forceReleaseLock, currentLock } from '../../server/services/lock'
import { seedProject, resetDb } from './helpers'

const info = (id: string) => ({ ID: id, Who: 'jj@laptop', Operation: 'OperationTypeApply' })

let projectId: string

beforeEach(async () => {
  await resetDb()
  projectId = await seedProject('acme', 'prod')
})

describe('locking', () => {
  it('acquires a free lock', async () => {
    expect(await acquireLock(projectId, info('lock-1'))).toEqual({ ok: true })
  })

  it('refuses a held lock and reports the holder', async () => {
    await acquireLock(projectId, info('lock-1'))
    const result = await acquireLock(projectId, info('lock-2'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.held.ID).toBe('lock-1')
  })

  it('gives the lock to exactly one of many concurrent callers', async () => {
    const attempts = Array.from({ length: 20 }, (_, i) => acquireLock(projectId, info(`c-${i}`)))
    const results = await Promise.all(attempts)
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  it('releases with the matching id', async () => {
    await acquireLock(projectId, info('lock-1'))
    expect(await releaseLock(projectId, 'lock-1')).toBe(true)
    expect(await currentLock(projectId)).toBeNull()
  })

  it('refuses to release with a mismatched id', async () => {
    await acquireLock(projectId, info('lock-1'))
    expect(await releaseLock(projectId, 'wrong')).toBe(false)
    expect((await currentLock(projectId))?.ID).toBe('lock-1')
  })

  it('force-releases regardless of id', async () => {
    await acquireLock(projectId, info('lock-1'))
    await forceReleaseLock(projectId)
    expect(await currentLock(projectId)).toBeNull()
  })

  it('is re-acquirable after release', async () => {
    await acquireLock(projectId, info('lock-1'))
    await releaseLock(projectId, 'lock-1')
    expect(await acquireLock(projectId, info('lock-2'))).toEqual({ ok: true })
  })
})
```

- [x] **Step 2: Write the test helpers**

```ts
// tests/protocol/helpers.ts
import { ulid } from 'ulid'
import { db } from '../../server/db/client'
import {
  organization, project, stateVersion, projectState, stateLock, auditLog
} from '../../server/db/schema'

export async function resetDb(): Promise<void> {
  await db().delete(stateLock)
  await db().delete(projectState)
  await db().delete(stateVersion)
  await db().delete(auditLog)
  await db().delete(project)
  await db().delete(organization)
}

export async function seedProject(orgSlug: string, projectSlug: string): Promise<string> {
  const orgId = ulid()
  const projectId = ulid()
  await db().insert(organization).values({ id: orgId, name: orgSlug, slug: orgSlug })
  await db().insert(project).values({
    id: projectId, orgId, name: projectSlug, slug: projectSlug
  })
  return projectId
}
```

- [x] **Step 3: Run and confirm it fails**

Run: `pnpm vitest run tests/protocol/lock.test.ts`
Expected: FAIL — `server/services/lock` not found.

- [x] **Step 4: Implement**

```ts
// server/services/lock.ts
import { eq, and } from 'drizzle-orm'
import { db } from '../db/client'
import { stateLock } from '../db/schema'
import { lockInfoSchema, type LockInfo } from '../../shared/schemas/lock'

export type AcquireResult = { ok: true } | { ok: false; held: LockInfo }

export async function acquireLock(projectId: string, info: LockInfo): Promise<AcquireResult> {
  // Single atomic statement. Two concurrent callers cannot both insert, because
  // project_id is the primary key. No transaction, no advisory lock, no read
  // before write — which is what makes this correct on Neon's HTTP driver too.
  const inserted = await db()
    .insert(stateLock)
    .values({
      projectId,
      lockId: info.ID,
      who: info.Who ?? null,
      operation: info.Operation ?? null,
      version: info.Version ?? null,
      infoJson: info
    })
    .onConflictDoNothing({ target: stateLock.projectId })
    .returning({ projectId: stateLock.projectId })

  if (inserted.length > 0) return { ok: true }

  const held = await currentLock(projectId)
  // The holder released between our insert and this read. Report the conflict
  // anyway: Terraform retries, and inventing a success we did not achieve is
  // the one outcome that could corrupt state.
  return { ok: false, held: held ?? { ID: 'unknown' } }
}

export async function releaseLock(projectId: string, lockId: string): Promise<boolean> {
  const deleted = await db()
    .delete(stateLock)
    .where(and(eq(stateLock.projectId, projectId), eq(stateLock.lockId, lockId)))
    .returning({ projectId: stateLock.projectId })
  return deleted.length > 0
}

export async function forceReleaseLock(projectId: string): Promise<void> {
  await db().delete(stateLock).where(eq(stateLock.projectId, projectId))
}

export async function currentLock(projectId: string): Promise<LockInfo | null> {
  const rows = await db().select().from(stateLock).where(eq(stateLock.projectId, projectId))
  const row = rows[0]
  if (!row) return null
  const parsed = lockInfoSchema.safeParse(row.infoJson)
  return parsed.success ? parsed.data : { ID: row.lockId }
}
```

- [x] **Step 5: Run tests and confirm they pass**

Run: `pnpm vitest run tests/protocol/lock.test.ts`
Expected: 7 passed. The concurrency test is the important one — if it reports more than one winner, stop and fix before continuing.

- [x] **Step 6: Commit**

```bash
git add server/services/lock.ts tests/protocol/
git commit -m "feat: add postgres-backed state locking"
```

---

### Task A3: State service and audit trail

**Files:**
- Create: `server/services/state.ts`, `server/services/audit.ts`
- Test: `tests/protocol/state.test.ts`

**Interfaces:**
- Consumes: `db()`, `store()`, `seal`/`open`, schema tables
- Produces:
  ```ts
  async function readCurrentState(projectId: string): Promise<Buffer | null>
  async function writeState(args: {
    projectId: string; orgSlug: string; projectSlug: string
    body: Buffer; userId: string
  }): Promise<{ versionId: string }>
  async function purgeState(projectId: string): Promise<void>
  async function listVersions(projectId: string, limit?: number): Promise<StateVersionRow[]>
  async function readVersion(versionId: string): Promise<Buffer | null>
  async function recordAudit(entry: AuditEntry): Promise<void>
  ```

- [x] **Step 1: Write the failing test**

```ts
// tests/protocol/state.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { readCurrentState, writeState, purgeState, listVersions } from '../../server/services/state'
import { db } from '../../server/db/client'
import { stateVersion } from '../../server/db/schema'
import { store } from '../../server/storage'
import { seedProject, resetDb } from './helpers'

const payload = (serial: number) =>
  Buffer.from(JSON.stringify({ version: 4, serial, lineage: 'abc', resources: [] }))

let projectId: string

beforeEach(async () => {
  await resetDb()
  projectId = await seedProject('acme', 'prod')
})

describe('state service', () => {
  it('returns null before any state is written', async () => {
    expect(await readCurrentState(projectId)).toBeNull()
  })

  it('round-trips a written state', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(1), userId: 'u1' })
    expect(await readCurrentState(projectId)).toEqual(payload(1))
  })

  it('keeps every version and moves the pointer', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(1), userId: 'u1' })
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(2), userId: 'u1' })
    expect(await listVersions(projectId)).toHaveLength(2)
    expect(await readCurrentState(projectId)).toEqual(payload(2))
  })

  it('never overwrites a blob key', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(1), userId: 'u1' })
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(2), userId: 'u1' })
    const rows = await db().select().from(stateVersion).where(eq(stateVersion.projectId, projectId))
    expect(new Set(rows.map((r) => r.blobKey)).size).toBe(2)
  })

  it('stores ciphertext, not plaintext', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(1), userId: 'u1' })
    const [row] = await db().select().from(stateVersion).where(eq(stateVersion.projectId, projectId))
    const raw = Buffer.from((await store().get(row!.blobKey))!)
    expect(raw.toString('utf8')).not.toContain('lineage')
  })

  it('records serial and lineage for display', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(7), userId: 'u1' })
    const [version] = await listVersions(projectId)
    expect(version?.serial).toBe(7)
    expect(version?.lineage).toBe('abc')
  })

  it('accepts state that is not valid JSON', async () => {
    const junk = Buffer.from('not json at all')
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: junk, userId: 'u1' })
    expect(await readCurrentState(projectId)).toEqual(junk)
  })

  it('purges state and clears the pointer', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(1), userId: 'u1' })
    await purgeState(projectId)
    expect(await readCurrentState(projectId)).toBeNull()
  })
})
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/protocol/state.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement audit**

```ts
// server/services/audit.ts
import { ulid } from 'ulid'
import { db } from '../db/client'
import { auditLog } from '../db/schema'

export type AuditEntry = {
  orgId: string
  projectId?: string
  actorType: 'user' | 'api-key'
  actorId?: string
  action: string
  meta?: Record<string, unknown>
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  await db().insert(auditLog).values({
    id: ulid(),
    orgId: entry.orgId,
    projectId: entry.projectId ?? null,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    metaJson: entry.meta ?? null
  })
}
```

- [x] **Step 4: Implement the state service**

```ts
// server/services/state.ts
import { createHash } from 'node:crypto'
import { ulid } from 'ulid'
import { eq, desc } from 'drizzle-orm'
import { db } from '../db/client'
import { stateVersion, projectState } from '../db/schema'
import { store } from '../storage'
import { seal, open } from '../utils/crypto'
import { env } from '../utils/env'

export type StateVersionRow = typeof stateVersion.$inferSelect

function blobKey(orgSlug: string, projectSlug: string, versionId: string): string {
  return `${orgSlug}/${projectSlug}/${versionId}.tfstate.enc`
}

// Terraform state is an opaque blob. We read these two fields for display only
// and tolerate their absence rather than validating the document's shape.
function peek(body: Buffer): { serial: number | null; lineage: string | null } {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { serial?: unknown; lineage?: unknown }
    return {
      serial: typeof parsed.serial === 'number' ? parsed.serial : null,
      lineage: typeof parsed.lineage === 'string' ? parsed.lineage : null
    }
  } catch {
    return { serial: null, lineage: null }
  }
}

export async function readCurrentState(projectId: string): Promise<Buffer | null> {
  const rows = await db()
    .select({ blobKey: stateVersion.blobKey })
    .from(projectState)
    .innerJoin(stateVersion, eq(projectState.currentVersionId, stateVersion.id))
    .where(eq(projectState.projectId, projectId))
  const key = rows[0]?.blobKey
  if (!key) return null
  const sealed = await store().get(key)
  if (!sealed) return null
  return open(env().ENCRYPTION_KEY, sealed)
}

export async function readVersion(versionId: string): Promise<Buffer | null> {
  const rows = await db()
    .select({ blobKey: stateVersion.blobKey })
    .from(stateVersion)
    .where(eq(stateVersion.id, versionId))
  const key = rows[0]?.blobKey
  if (!key) return null
  const sealed = await store().get(key)
  return sealed ? open(env().ENCRYPTION_KEY, sealed) : null
}

export async function writeState(args: {
  projectId: string
  orgSlug: string
  projectSlug: string
  body: Buffer
  userId: string
}): Promise<{ versionId: string }> {
  const versionId = ulid()
  const key = blobKey(args.orgSlug, args.projectSlug, versionId)
  const { serial, lineage } = peek(args.body)

  // Ordering is load-bearing: blob first, row second, pointer last. A failure
  // after the blob write leaves an unreferenced object, which the retention
  // sweep collects. The reverse order would leave a pointer to nothing.
  await store().put(key, seal(env().ENCRYPTION_KEY, args.body))

  await db().insert(stateVersion).values({
    id: versionId,
    projectId: args.projectId,
    serial,
    lineage,
    sizeBytes: args.body.length,
    md5: createHash('md5').update(args.body).digest('hex'),
    blobKey: key,
    createdBy: args.userId
  })

  await db()
    .insert(projectState)
    .values({ projectId: args.projectId, currentVersionId: versionId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: projectState.projectId,
      set: { currentVersionId: versionId, updatedAt: new Date() }
    })

  return { versionId }
}

export async function purgeState(projectId: string): Promise<void> {
  await db().delete(projectState).where(eq(projectState.projectId, projectId))
}

export async function listVersions(projectId: string, limit = 100): Promise<StateVersionRow[]> {
  return db()
    .select()
    .from(stateVersion)
    .where(eq(stateVersion.projectId, projectId))
    .orderBy(desc(stateVersion.createdAt))
    .limit(limit)
}
```

- [x] **Step 5: Run tests and confirm they pass**

Run: `pnpm vitest run tests/protocol/state.test.ts`
Expected: 8 passed.

- [x] **Step 6: Commit**

```bash
git add server/services/ tests/protocol/state.test.ts
git commit -m "feat: add versioned encrypted state service with audit trail"
```

---

### Task A4: Protocol endpoints

**Files:**
- Create: `server/api/tf/[org]/[project]/index.ts`, `server/api/tf/[org]/[project]/lock.ts`
- Create: `server/utils/tf-handler.ts`
- Test: `tests/protocol/endpoints.test.ts`

**Interfaces:**
- Consumes: everything from A1–A3
- Produces: the live HTTP surface described in the spec's routing table.

- [x] **Step 1: Write the failing test**

```ts
// tests/protocol/endpoints.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { auth } from '../../server/utils/auth'
import { seedProject, resetDb } from './helpers'

await setup({ server: true })

let token: string
const url = '/api/tf/acme/prod'
const authHeader = () => ({ authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` })
const state = (serial: number) => JSON.stringify({ version: 4, serial, lineage: 'l1' })

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

beforeEach(async () => {
  await resetDb()
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
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('allows an unlocked write', async () => {
    await $fetch(`${url}`, { method: 'POST', headers: authHeader(), body: state(1) })
    expect(await $fetch(url, { headers: authHeader() })).toMatchObject({ serial: 1 })
  })

  it('accepts the LOCK and UNLOCK verbs as well', async () => {
    await $fetch(`${url}/lock`, { method: 'LOCK', headers: authHeader(), body: { ID: 'v' } })
    await expect(
      $fetch(`${url}/lock`, { method: 'POST', headers: authHeader(), body: { ID: 'w' } })
    ).rejects.toMatchObject({ statusCode: 423 })
    await $fetch(`${url}/lock`, { method: 'UNLOCK', headers: authHeader(), body: { ID: 'v' } })
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
```

- [x] **Step 2: Install the test harness and run**

```bash
pnpm add -D @nuxt/test-utils playwright-core
pnpm vitest run tests/protocol/endpoints.test.ts
```
Expected: FAIL — routes do not exist.

- [x] **Step 3: Implement the shared handler helper**

```ts
// server/utils/tf-handler.ts
import type { H3Event } from 'h3'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/client'
import { organization, project } from '../db/schema'
import { projectRefSchema, type ProjectRef } from '../../shared/schemas/project'

export type ResolvedProject = { id: string; orgId: string; ref: ProjectRef }

export async function refFromEvent(event: H3Event): Promise<ProjectRef> {
  try {
    return await getValidatedRouterParams(event, projectRefSchema.parse)
  } catch {
    // h3 turns any validator throw into a 400. Spec §11 requires 404 for a project
    // that cannot exist, so the status is restored here rather than inside the
    // validator, where it would be swallowed.
    throw createError({ statusCode: 404, statusMessage: 'Unknown project' })
  }
}

export async function resolveProject(ref: ProjectRef): Promise<ResolvedProject> {
  const rows = await db()
    .select({ id: project.id, orgId: project.orgId })
    .from(project)
    .innerJoin(organization, eq(project.orgId, organization.id))
    .where(and(eq(organization.slug, ref.org), eq(project.slug, ref.project)))
  const row = rows[0]
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Unknown project' })
  return { id: row.id, orgId: row.orgId, ref }
}
```

- [x] **Step 4: Implement the state endpoint**

```ts
// server/api/tf/[org]/[project]/index.ts
import { authorizeTf } from '../../../../utils/tf-auth'
import { refFromEvent, resolveProject } from '../../../../utils/tf-handler'
import { readCurrentState, writeState, purgeState } from '../../../../services/state'
import { recordAudit } from '../../../../services/audit'
import { currentLock, acquireLock, releaseLock } from '../../../../services/lock'
import { lockInfoSchema } from '../../../../../shared/schemas/lock'
import type { StateAction } from '../../../../../shared/schemas/token'

const ACTION_FOR_METHOD: Record<string, StateAction> = {
  GET: 'read', POST: 'write', DELETE: 'delete', LOCK: 'lock', UNLOCK: 'lock'
}

// Terraform appends ?ID=<lock-id> to a write while a lock is held.
const lockQuerySchema = z.object({ ID: z.string().min(1).optional() })

export default defineEventHandler(async (event) => {
  const method = event.method.toUpperCase()
  const action = ACTION_FOR_METHOD[method]
  if (!action) throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })

  const ref = await refFromEvent(event)
  const resolved = await resolveProject(ref)
  const principal = await authorizeTf(event, ref, action)

  if (method === 'GET') {
    const body = await readCurrentState(resolved.id)
    if (!body) throw createError({ statusCode: 404, statusMessage: 'No state' })
    setResponseHeader(event, 'content-type', 'application/json')
    return body
  }

  // Terraform can be configured to send LOCK/UNLOCK to the base address.
  if (method === 'LOCK' || method === 'UNLOCK') {
    return handleLockOnBase(event, resolved, method)
  }

  if (method === 'POST') {
    const held = await currentLock(resolved.id)
    if (held) {
      const { ID: supplied } = await getValidatedQuery(event, lockQuerySchema.parse)
      if (supplied !== held.ID) {
        throw createError({
          statusCode: 409,
          statusMessage: `State is locked by ${held.Who ?? 'another process'}`
        })
      }
    }
    const body = Buffer.from(await readRawBody(event, false) ?? Buffer.alloc(0))
    const { versionId } = await writeState({
      projectId: resolved.id,
      orgSlug: ref.org,
      projectSlug: ref.project,
      body,
      userId: principal.userId
    })
    await recordAudit({
      orgId: resolved.orgId, projectId: resolved.id, actorType: 'api-key',
      actorId: principal.keyId, action: 'state.write', meta: { versionId, bytes: body.length }
    })
    return { ok: true }
  }

  await purgeState(resolved.id)
  await recordAudit({
    orgId: resolved.orgId, projectId: resolved.id, actorType: 'api-key',
    actorId: principal.keyId, action: 'state.purge'
  })
  return { ok: true }
})

async function handleLockOnBase(
  event: H3Event,
  resolved: { id: string },
  method: string
): Promise<{ ok: true }> {
  // 400 is the correct status for a malformed lock body, so h3's default applies
  // and no catch is needed here.
  const info = await readValidatedBody(event, lockInfoSchema.parse)
  if (method === 'LOCK') {
    const result = await acquireLock(resolved.id, info)
    if (!result.ok) {
      throw createError({ statusCode: 423, statusMessage: 'Locked', data: result.held })
    }
    return { ok: true }
  }
  await releaseLock(resolved.id, info.ID)
  return { ok: true }
}
```

`H3Event` is imported as a type at the top of the file:

```ts
import type { H3Event } from 'h3'
```

- [x] **Step 5: Implement the lock endpoint**

```ts
// server/api/tf/[org]/[project]/lock.ts
import { authorizeTf } from '../../../../utils/tf-auth'
import { refFromEvent, resolveProject } from '../../../../utils/tf-handler'
import { acquireLock, releaseLock } from '../../../../services/lock'
import { recordAudit } from '../../../../services/audit'
import { lockInfoSchema } from '../../../../../shared/schemas/lock'

const ACQUIRE = new Set(['POST', 'LOCK'])
const RELEASE = new Set(['DELETE', 'UNLOCK'])

export default defineEventHandler(async (event) => {
  const method = event.method.toUpperCase()
  if (!ACQUIRE.has(method) && !RELEASE.has(method)) {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const ref = await refFromEvent(event)
  const resolved = await resolveProject(ref)
  const principal = await authorizeTf(event, ref, 'lock')

  // 400 on a malformed body is exactly what the spec wants, so h3's default status
  // is correct and the call needs no catch.
  const info = await readValidatedBody(event, lockInfoSchema.parse)

  if (ACQUIRE.has(method)) {
    const result = await acquireLock(resolved.id, info)
    if (!result.ok) {
      // The body must carry the holder's lock info or Terraform cannot tell the
      // user who holds the lock.
      throw createError({ statusCode: 423, statusMessage: 'Locked', data: result.held })
    }
    await recordAudit({
      orgId: resolved.orgId, projectId: resolved.id, actorType: 'api-key',
      actorId: principal.keyId, action: 'lock.acquire', meta: { lockId: info.ID, who: info.Who }
    })
    return { ok: true }
  }

  const released = await releaseLock(resolved.id, info.ID)
  await recordAudit({
    orgId: resolved.orgId, projectId: resolved.id, actorType: 'api-key',
    actorId: principal.keyId, action: released ? 'lock.release' : 'lock.release_mismatch',
    meta: { lockId: info.ID }
  })
  return { ok: true }
})
```

- [x] **Step 6: Run tests and confirm they pass**

Run: `pnpm vitest run tests/protocol/endpoints.test.ts`
Expected: 10 passed.

- [x] **Step 7: Commit**

```bash
git add server/api/tf server/utils/tf-handler.ts tests/protocol/endpoints.test.ts
git commit -m "feat: implement the terraform http backend protocol endpoints"
```

---

### Task A5: Retention and orphan sweep

**Files:**
- Create: `server/services/retention.ts`, `server/api/admin/retention.post.ts`
- Test: `tests/protocol/retention.test.ts`

**Interfaces:**
- Consumes: `db()`, `store()`, `env()`
- Produces: `async function runRetention(projectId: string): Promise<{ prunedVersions: number; sweptBlobs: number }>`

- [x] **Step 1: Write the failing test**

```ts
// tests/protocol/retention.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { runRetention } from '../../server/services/retention'
import { writeState, listVersions, readCurrentState } from '../../server/services/state'
import { store } from '../../server/storage'
import { seedProject, resetDb } from './helpers'

let projectId: string
const body = (n: number) => Buffer.from(JSON.stringify({ version: 4, serial: n }))

beforeEach(async () => {
  await resetDb()
  projectId = await seedProject('acme', 'prod')
})

describe('retention', () => {
  it('keeps everything below the version threshold', async () => {
    for (let i = 1; i <= 5; i++) {
      await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: body(i), userId: 'u' })
    }
    await runRetention(projectId)
    expect(await listVersions(projectId)).toHaveLength(5)
  })

  it('never prunes the current version', async () => {
    for (let i = 1; i <= 3; i++) {
      await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: body(i), userId: 'u' })
    }
    await runRetention(projectId)
    expect(await readCurrentState(projectId)).toEqual(body(3))
  })

  it('sweeps a blob with no version row', async () => {
    await store().put('acme/prod/ORPHAN.tfstate.enc', new Uint8Array([1, 2, 3]))
    const result = await runRetention(projectId)
    expect(result.sweptBlobs).toBe(1)
    expect(await store().get('acme/prod/ORPHAN.tfstate.enc')).toBeNull()
  })
})
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/protocol/retention.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

```ts
// server/services/retention.ts
import { eq, inArray, desc } from 'drizzle-orm'
import { db } from '../db/client'
import { stateVersion, projectState, project, organization } from '../db/schema'
import { store } from '../storage'
import { env } from '../utils/env'

export async function runRetention(
  projectId: string
): Promise<{ prunedVersions: number; sweptBlobs: number }> {
  const config = env()

  const rows = await db()
    .select({ id: projectState.currentVersionId })
    .from(projectState)
    .where(eq(projectState.projectId, projectId))
  const currentId = rows[0]?.id ?? null

  const all = await db()
    .select()
    .from(stateVersion)
    .where(eq(stateVersion.projectId, projectId))
    .orderBy(desc(stateVersion.createdAt))

  const cutoff = new Date(Date.now() - config.RETENTION_KEEP_DAYS * 86_400_000)
  const doomed = all.filter(
    (v, index) =>
      v.id !== currentId &&
      index >= config.RETENTION_KEEP_VERSIONS &&
      v.createdAt < cutoff
  )

  if (doomed.length > 0) {
    await db().delete(stateVersion).where(inArray(stateVersion.id, doomed.map((v) => v.id)))
    for (const v of doomed) await store().delete(v.blobKey)
  }

  const sweptBlobs = await sweepOrphans(projectId)
  return { prunedVersions: doomed.length, sweptBlobs }
}

async function sweepOrphans(projectId: string): Promise<number> {
  const meta = await db()
    .select({ orgSlug: organization.slug, projectSlug: project.slug })
    .from(project)
    .innerJoin(organization, eq(project.orgId, organization.id))
    .where(eq(project.id, projectId))
  const location = meta[0]
  if (!location) return 0

  const prefix = `${location.orgSlug}/${location.projectSlug}/`
  const onDisk = await store().list(prefix)
  const known = new Set(
    (
      await db()
        .select({ blobKey: stateVersion.blobKey })
        .from(stateVersion)
        .where(eq(stateVersion.projectId, projectId))
    ).map((r) => r.blobKey)
  )

  let swept = 0
  for (const key of onDisk) {
    if (!known.has(key)) {
      await store().delete(key)
      swept++
    }
  }
  return swept
}
```

```ts
// server/api/admin/retention.post.ts
import { auth } from '../../utils/auth'
import { db } from '../../db/client'
import { project } from '../../db/schema'
import { runRetention } from '../../services/retention'

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers })
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Sign in required' })

  const projects = await db().select({ id: project.id }).from(project)
  const results = await Promise.all(projects.map((p) => runRetention(p.id)))
  return {
    prunedVersions: results.reduce((sum, r) => sum + r.prunedVersions, 0),
    sweptBlobs: results.reduce((sum, r) => sum + r.sweptBlobs, 0)
  }
})
```

- [x] **Step 4: Run tests and confirm they pass**

Run: `pnpm vitest run tests/protocol/retention.test.ts`
Expected: 3 passed.

- [x] **Step 5: Commit**

```bash
git add server/services/retention.ts server/api/admin tests/protocol/retention.test.ts
git commit -m "feat: add version retention and orphan blob sweep"
```

---

### Task A6: Rollback

Spec §10 promises one-click rollback. Rollback never rewrites history: it reads an
old version's bytes and writes them as a **new** version, so the timeline stays an
append-only record of what actually happened.

**Files:**
- Create: `server/api/admin/rollback.post.ts`
- Test: `tests/protocol/rollback.test.ts`

**Interfaces:**
- Consumes: `readVersion`, `writeState` (A3), `currentLock` (A2), `requireSession`
- Produces: `POST /api/admin/rollback` with body `{ projectId: string; versionId: string }`, returning `{ versionId: string }` — the id of the newly created version.

**Cross-lane note:** Lane B's timeline page (Task B5) adds a button that calls this
endpoint. The button is additive and can be written before this endpoint exists; it
only needs to work after both lanes merge.

- [x] **Step 1: Write the failing test**

```ts
// tests/protocol/rollback.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { writeState, readCurrentState, listVersions } from '../../server/services/state'
import { rollbackTo } from '../../server/services/state'
import { acquireLock } from '../../server/services/lock'
import { seedProject, resetDb } from './helpers'

let projectId: string
const body = (n: number) => Buffer.from(JSON.stringify({ version: 4, serial: n }))

beforeEach(async () => {
  await resetDb()
  projectId = await seedProject('acme', 'prod')
})

describe('rollback', () => {
  it('restores an older version as the current state', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: body(1), userId: 'u' })
    const [first] = await listVersions(projectId)
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: body(2), userId: 'u' })

    await rollbackTo({ projectId, orgSlug: 'acme', projectSlug: 'prod', versionId: first!.id, userId: 'u' })
    expect(await readCurrentState(projectId)).toEqual(body(1))
  })

  it('appends rather than rewriting history', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: body(1), userId: 'u' })
    const [first] = await listVersions(projectId)
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: body(2), userId: 'u' })

    await rollbackTo({ projectId, orgSlug: 'acme', projectSlug: 'prod', versionId: first!.id, userId: 'u' })
    expect(await listVersions(projectId)).toHaveLength(3)
  })

  it('refuses to roll back while the state is locked', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: body(1), userId: 'u' })
    const [first] = await listVersions(projectId)
    await acquireLock(projectId, { ID: 'held', Who: 'someone' })

    await expect(
      rollbackTo({ projectId, orgSlug: 'acme', projectSlug: 'prod', versionId: first!.id, userId: 'u' })
    ).rejects.toThrow(/locked/i)
  })

  it('rejects an unknown version id', async () => {
    await expect(
      rollbackTo({ projectId, orgSlug: 'acme', projectSlug: 'prod', versionId: 'nope', userId: 'u' })
    ).rejects.toThrow(/not found/i)
  })
})
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/protocol/rollback.test.ts`
Expected: FAIL — `rollbackTo` is not exported.

- [x] **Step 3: Add `rollbackTo` to the state service**

Append to `server/services/state.ts`:

```ts
import { currentLock } from './lock'

export async function rollbackTo(args: {
  projectId: string
  orgSlug: string
  projectSlug: string
  versionId: string
  userId: string
}): Promise<{ versionId: string }> {
  // Rolling back under an active lock would race a running apply.
  const held = await currentLock(args.projectId)
  if (held) {
    throw new Error(`State is locked by ${held.Who ?? 'another process'}; release it first`)
  }

  const body = await readVersion(args.versionId)
  if (!body) throw new Error(`Version not found: ${args.versionId}`)

  // A new version carrying old bytes. History is append-only.
  return writeState({
    projectId: args.projectId,
    orgSlug: args.orgSlug,
    projectSlug: args.projectSlug,
    body,
    userId: args.userId
  })
}
```

- [x] **Step 4: Add the endpoint**

```ts
// server/api/admin/rollback.post.ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { auth } from '../../utils/auth'
import { db } from '../../db/client'
import { project, organization } from '../../db/schema'
import { rollbackTo } from '../../services/state'
import { recordAudit } from '../../services/audit'

const bodySchema = z.object({ projectId: z.string().min(1), versionId: z.string().min(1) })

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers })
  if (!session?.user) throw createError({ statusCode: 401, statusMessage: 'Sign in required' })

  const body = await readValidatedBody(event, bodySchema.parse)

  const rows = await db()
    .select({ orgId: project.orgId, orgSlug: organization.slug, projectSlug: project.slug })
    .from(project)
    .innerJoin(organization, eq(project.orgId, organization.id))
    .where(eq(project.id, body.projectId))
  const target = rows[0]
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Unknown project' })

  try {
    const result = await rollbackTo({
      projectId: body.projectId,
      orgSlug: target.orgSlug,
      projectSlug: target.projectSlug,
      versionId: body.versionId,
      userId: session.user.id
    })
    await recordAudit({
      orgId: target.orgId,
      projectId: body.projectId,
      actorType: 'user',
      actorId: session.user.id,
      action: 'state.rollback',
      meta: { from: body.versionId, to: result.versionId }
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Rollback failed'
    throw createError({ statusCode: /locked/i.test(message) ? 409 : 404, statusMessage: message })
  }
})
```

- [x] **Step 5: Run tests and confirm they pass**

Run: `pnpm vitest run tests/protocol/rollback.test.ts`
Expected: 4 passed.

- [x] **Step 6: Commit**

```bash
git add server/services/state.ts server/api/admin/rollback.post.ts tests/protocol/rollback.test.ts
git commit -m "feat: add append-only state rollback"
```

---

## Lane A exit gate

```bash
pnpm vitest run tests/protocol
pnpm vue-tsc --noEmit
```

All protocol tests green, zero type errors, no `any`.

---

# LANE B — Dashboard

**Runs in parallel with Lane A.** Agent owns `app/**`, `server/api/ui/**`, `tests/ui/**`. Touches nothing else.

Lane B queries Drizzle directly for its read views rather than importing Lane A's services. This is deliberate: it removes the only dependency that would have serialised the two lanes, and the read paths are genuinely different (list-and-paginate vs. fetch-one-and-decrypt).

**Every task in this lane ends with a Web Interface Guidelines audit — see Appendix A.** A task is not done until its audit is clean.

---

### Task B1: Dashboard read API

**Files:**
- Create: `server/api/ui/projects.get.ts`, `server/api/ui/projects/[id]/versions.get.ts`, `server/api/ui/projects/[id]/lock.delete.ts`, `server/api/ui/versions/[id].get.ts`, `server/utils/ui-auth.ts`
- Test: `tests/ui/api.test.ts`

**Interfaces:**
- Consumes: `auth`, `db()`, schema, `open()`, `env()`
- Produces:
  ```ts
  async function requireSession(event: H3Event): Promise<{ userId: string }>
  ```
  Endpoints: `GET /api/ui/projects`, `GET /api/ui/projects/:id/versions`, `GET /api/ui/versions/:id`, `DELETE /api/ui/projects/:id/lock`

- [x] **Step 1: Write the failing test**

```ts
// tests/ui/api.test.ts
import { describe, it, expect } from 'vitest'
import { $fetch, setup } from '@nuxt/test-utils/e2e'

await setup({ server: true })

describe('dashboard api', () => {
  it('rejects an unauthenticated project list', async () => {
    await expect($fetch('/api/ui/projects')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an unauthenticated version read', async () => {
    await expect($fetch('/api/ui/versions/01ABC')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an unauthenticated force-unlock', async () => {
    await expect(
      $fetch('/api/ui/projects/p1/lock', { method: 'DELETE' })
    ).rejects.toMatchObject({ statusCode: 401 })
  })
})
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/ui/api.test.ts`
Expected: FAIL — routes return 404, not 401.

- [x] **Step 3: Implement the session guard**

```ts
// server/utils/ui-auth.ts
import type { H3Event } from 'h3'
import { auth } from './auth'

export async function requireSession(event: H3Event): Promise<{ userId: string }> {
  const session = await auth.api.getSession({ headers: event.headers })
  if (!session?.user) throw createError({ statusCode: 401, statusMessage: 'Sign in required' })
  return { userId: session.user.id }
}
```

- [x] **Step 4: Implement the endpoints**

```ts
// server/api/ui/projects.get.ts
import { eq, desc, sql } from 'drizzle-orm'
import { requireSession } from '../../utils/ui-auth'
import { db } from '../../db/client'
import { project, organization, projectState, stateVersion, stateLock } from '../../db/schema'

export default defineEventHandler(async (event) => {
  await requireSession(event)
  return db()
    .select({
      id: project.id,
      slug: project.slug,
      name: project.name,
      org: organization.slug,
      updatedAt: projectState.updatedAt,
      serial: stateVersion.serial,
      sizeBytes: stateVersion.sizeBytes,
      lockedBy: stateLock.who,
      versionCount: sql<number>`(
        select count(*)::int from state_version sv where sv.project_id = ${project.id}
      )`
    })
    .from(project)
    .innerJoin(organization, eq(project.orgId, organization.id))
    .leftJoin(projectState, eq(projectState.projectId, project.id))
    .leftJoin(stateVersion, eq(projectState.currentVersionId, stateVersion.id))
    .leftJoin(stateLock, eq(stateLock.projectId, project.id))
    .orderBy(desc(projectState.updatedAt))
})
```

```ts
// server/api/ui/projects/[id]/versions.get.ts
import { eq, desc } from 'drizzle-orm'
import { requireSession } from '../../../../utils/ui-auth'
import { db } from '../../../../db/client'
import { stateVersion, projectState, user } from '../../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const projectId = getRouterParam(event, 'id')
  if (!projectId) throw createError({ statusCode: 400, statusMessage: 'Missing project id' })

  const pointer = await db()
    .select({ currentVersionId: projectState.currentVersionId })
    .from(projectState)
    .where(eq(projectState.projectId, projectId))

  const versions = await db()
    .select({
      id: stateVersion.id,
      serial: stateVersion.serial,
      lineage: stateVersion.lineage,
      sizeBytes: stateVersion.sizeBytes,
      md5: stateVersion.md5,
      createdAt: stateVersion.createdAt,
      authorName: user.name,
      authorEmail: user.email
    })
    .from(stateVersion)
    .leftJoin(user, eq(stateVersion.createdBy, user.id))
    .where(eq(stateVersion.projectId, projectId))
    .orderBy(desc(stateVersion.createdAt))
    .limit(200)

  return { currentVersionId: pointer[0]?.currentVersionId ?? null, versions }
})
```

```ts
// server/api/ui/versions/[id].get.ts
import { eq } from 'drizzle-orm'
import { requireSession } from '../../../utils/ui-auth'
import { db } from '../../../db/client'
import { stateVersion } from '../../../db/schema'
import { store } from '../../../storage'
import { open } from '../../../utils/crypto'
import { env } from '../../../utils/env'

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing version id' })

  const rows = await db()
    .select({ blobKey: stateVersion.blobKey })
    .from(stateVersion)
    .where(eq(stateVersion.id, id))
  const key = rows[0]?.blobKey
  if (!key) throw createError({ statusCode: 404, statusMessage: 'Unknown version' })

  const sealed = await store().get(key)
  if (!sealed) throw createError({ statusCode: 404, statusMessage: 'Blob missing' })

  const plain = open(env().ENCRYPTION_KEY, sealed).toString('utf8')
  try {
    return { json: JSON.parse(plain) as unknown, raw: null }
  } catch {
    return { json: null, raw: plain }
  }
})
```

```ts
// server/api/ui/projects/[id]/lock.delete.ts
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { requireSession } from '../../../../utils/ui-auth'
import { db } from '../../../../db/client'
import { stateLock, auditLog, project } from '../../../../db/schema'

export default defineEventHandler(async (event) => {
  const session = await requireSession(event)
  const projectId = getRouterParam(event, 'id')
  if (!projectId) throw createError({ statusCode: 400, statusMessage: 'Missing project id' })

  const rows = await db().select({ orgId: project.orgId }).from(project).where(eq(project.id, projectId))
  const orgId = rows[0]?.orgId
  if (!orgId) throw createError({ statusCode: 404, statusMessage: 'Unknown project' })

  await db().delete(stateLock).where(eq(stateLock.projectId, projectId))
  await db().insert(auditLog).values({
    id: ulid(), orgId, projectId,
    actorType: 'user', actorId: session.userId,
    action: 'lock.force_release', metaJson: null
  })
  return { ok: true }
})
```

- [x] **Step 5: Run tests and confirm they pass**

Run: `pnpm vitest run tests/ui/api.test.ts`
Expected: 3 passed.

- [x] **Step 6: Commit**

```bash
git add server/api/ui server/utils/ui-auth.ts tests/ui/api.test.ts
git commit -m "feat: add session-guarded dashboard read api"
```

---

### Task B2: Token management API

**Files:**
- Create: `server/utils/token-mapping.ts`
- Create: `server/api/ui/tokens.get.ts`, `server/api/ui/tokens.post.ts`, `server/api/ui/tokens/[id].delete.ts`
- Test: `tests/ui/tokens.test.ts`

**Interfaces:**
- Consumes: `auth`, `requireSession`, `tokenConfigSchema` (0.6)
- Produces: `POST /api/ui/tokens` accepting a `TokenConfig` and returning `{ id, key }` — `key` is the raw value and is returned exactly once.

- [x] **Step 1: Write the failing test**

```ts
// tests/ui/tokens.test.ts
import { describe, it, expect } from 'vitest'
import { tokenConfigSchema } from '../../shared/schemas/token'
import { toApiKeyBody } from '../../server/utils/token-mapping'

describe('token config mapping', () => {
  it('maps actions onto state permissions', () => {
    const config = tokenConfigSchema.parse({
      name: 'ci', actions: ['read', 'write'], scope: { kind: 'all' }
    })
    expect(toApiKeyBody(config, 'u1').permissions).toEqual({ state: ['read', 'write'] })
  })

  it('carries project scope into metadata', () => {
    const config = tokenConfigSchema.parse({
      name: 'ci', actions: ['read'], scope: { kind: 'projects', projects: ['acme/prod'] }
    })
    expect(toApiKeyBody(config, 'u1').metadata).toEqual({
      scope: { kind: 'projects', projects: ['acme/prod'] }
    })
  })

  it('converts expiry days to seconds', () => {
    const config = tokenConfigSchema.parse({
      name: 'ci', actions: ['read'], scope: { kind: 'all' }, expiresInDays: 7
    })
    expect(toApiKeyBody(config, 'u1').expiresIn).toBe(604_800)
  })

  it('omits expiry when unset', () => {
    const config = tokenConfigSchema.parse({ name: 'ci', actions: ['read'], scope: { kind: 'all' } })
    expect(toApiKeyBody(config, 'u1').expiresIn).toBeUndefined()
  })

  it('enables rate limiting only when a max is given', () => {
    const off = tokenConfigSchema.parse({ name: 'a', actions: ['read'], scope: { kind: 'all' } })
    const on = tokenConfigSchema.parse({
      name: 'b', actions: ['read'], scope: { kind: 'all' },
      rateLimitMax: 60, rateLimitWindowSeconds: 60
    })
    expect(toApiKeyBody(off, 'u1').rateLimitEnabled).toBe(false)
    expect(toApiKeyBody(on, 'u1').rateLimitTimeWindow).toBe(60_000)
  })
})
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/ui/tokens.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the mapping**

```ts
// server/utils/token-mapping.ts
import type { TokenConfig } from '../../shared/schemas/token'

export type ApiKeyBody = {
  userId: string
  name: string
  prefix: string
  permissions: { state: string[] }
  metadata: { scope: TokenConfig['scope'] }
  expiresIn?: number
  rateLimitEnabled: boolean
  rateLimitMax?: number
  rateLimitTimeWindow?: number
}

export function toApiKeyBody(config: TokenConfig, userId: string): ApiKeyBody {
  return {
    userId,
    name: config.name,
    prefix: 'sm_',
    permissions: { state: [...config.actions] },
    metadata: { scope: config.scope },
    expiresIn: config.expiresInDays ? config.expiresInDays * 86_400 : undefined,
    rateLimitEnabled: config.rateLimitMax !== undefined,
    rateLimitMax: config.rateLimitMax,
    rateLimitTimeWindow: config.rateLimitWindowSeconds
      ? config.rateLimitWindowSeconds * 1000
      : undefined
  }
}
```

- [x] **Step 4: Implement the endpoints**

```ts
// server/api/ui/tokens.post.ts
import { requireSession } from '../../utils/ui-auth'
import { auth } from '../../utils/auth'
import { toApiKeyBody } from '../../utils/token-mapping'
import { tokenConfigSchema } from '../../../shared/schemas/token'

export default defineEventHandler(async (event) => {
  const session = await requireSession(event)
  // h3 raises a 400 carrying the Zod issues when this fails, which is what the
  // configurator form needs to render field-level errors.
  const config = await readValidatedBody(event, tokenConfigSchema.parse)
  const created = await auth.api.createApiKey({ body: toApiKeyBody(config, session.userId) })
  // The raw key is returned once and never again.
  return { id: created.id, key: created.key, name: created.name }
})
```

```ts
// server/api/ui/tokens.get.ts
import { requireSession } from '../../utils/ui-auth'
import { auth } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const keys = await auth.api.listApiKeys({ headers: event.headers })
  return keys.map((k) => ({
    id: k.id, name: k.name, prefix: k.prefix, start: k.start,
    enabled: k.enabled, expiresAt: k.expiresAt, lastRequest: k.lastRequest,
    permissions: k.permissions, metadata: k.metadata
  }))
})
```

```ts
// server/api/ui/tokens/[id].delete.ts
import { requireSession } from '../../../utils/ui-auth'
import { auth } from '../../../utils/auth'

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const keyId = getRouterParam(event, 'id')
  if (!keyId) throw createError({ statusCode: 400, statusMessage: 'Missing token id' })
  await auth.api.deleteApiKey({ body: { keyId }, headers: event.headers })
  return { ok: true }
})
```

- [x] **Step 5: Run tests and confirm they pass**

Run: `pnpm vitest run tests/ui/tokens.test.ts`
Expected: 5 passed.

- [x] **Step 6: Commit**

```bash
git add server/api/ui/tokens* server/utils/token-mapping.ts tests/ui/tokens.test.ts
git commit -m "feat: add token management api"
```

---

### Task B3: Dashboard shell

**Files:**
- Create: `app/layouts/dashboard.vue`, `app/pages/login.vue`, `app/middleware/auth.global.ts`, `app/composables/useAuth.ts`
- Test: covered by the audit in Step 5

**Interfaces:**
- Consumes: Better Auth client
- Produces: the `dashboard` layout every subsequent page uses.

- [x] **Step 1: Create the auth client**

```ts
// app/composables/useAuth.ts
import { createAuthClient } from 'better-auth/vue'
import { apiKeyClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({ plugins: [apiKeyClient()] })

export function useAuth() {
  const session = authClient.useSession()
  return {
    session,
    signIn: authClient.signIn.email,
    signOut: authClient.signOut
  }
}
```

- [x] **Step 2: Build the layout**

```vue
<!-- app/layouts/dashboard.vue -->
<script setup lang="ts">
const { session, signOut } = useAuth()
const route = useRoute()

const links = [
  { label: 'Projects', icon: 'i-lucide-boxes', to: '/' },
  { label: 'Tokens', icon: 'i-lucide-key-round', to: '/tokens' }
]
</script>

<template>
  <div class="min-h-dvh bg-default text-default">
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:m-3 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-inverted"
    >
      Skip to Content
    </a>

    <header class="sticky top-0 z-40 border-b border-default bg-default/85 backdrop-blur">
      <div class="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <NuxtLink to="/" class="flex items-center gap-2 font-semibold tracking-tight">
          <UIcon name="i-lucide-landmark" class="size-5 text-primary" aria-hidden="true" />
          <span translate="no">statesman</span>
        </NuxtLink>

        <UNavigationMenu :items="links" class="hidden sm:flex" />

        <div class="ms-auto flex items-center gap-2">
          <UColorModeButton />
          <UDropdownMenu
            v-if="session.data"
            :items="[[{ label: 'Sign Out', icon: 'i-lucide-log-out', onSelect: () => signOut() }]]"
          >
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-user"
              :aria-label="`Account menu for ${session.data.user.email}`"
            />
          </UDropdownMenu>
        </div>
      </div>
    </header>

    <main id="main" class="mx-auto max-w-6xl px-4 py-8">
      <slot />
    </main>
  </div>
</template>
```

Accessibility notes baked in above, each mapping to an Appendix A rule: a skip link before the header; `aria-hidden` on the decorative logo icon; an `aria-label` on the icon-only account button; `translate="no"` on the product name; Title Case on the action label.

- [x] **Step 3: Add the route guard**

```ts
// app/middleware/auth.global.ts
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login') return
  const { data } = await authClient.getSession()
  if (!data) return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
})
```

- [x] **Step 4: Build the login page**

```vue
<!-- app/pages/login.vue -->
<script setup lang="ts">
import { z } from 'zod'

definePageMeta({ layout: false })

const schema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters')
})
type Schema = z.infer<typeof schema>

const state = reactive<Partial<Schema>>({ email: undefined, password: undefined })
const pending = ref(false)
const formError = ref<string | null>(null)
const route = useRoute()

async function onSubmit(event: { data: Schema }) {
  pending.value = true
  formError.value = null
  const { error } = await authClient.signIn.email(event.data)
  pending.value = false
  if (error) {
    formError.value = 'That email and password did not match. Check both and try again.'
    return
  }
  await navigateTo((route.query.redirect as string) ?? '/')
}
</script>

<template>
  <div class="grid min-h-dvh place-items-center bg-muted px-4">
    <UCard class="w-full max-w-sm">
      <template #header>
        <h1 class="text-lg font-semibold tracking-tight">Sign In to statesman</h1>
      </template>

      <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
        <UFormField label="Email" name="email" required>
          <UInput
            v-model="state.email"
            type="email"
            name="email"
            autocomplete="username"
            :spellcheck="false"
            placeholder="you@example.com"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput
            v-model="state.password"
            type="password"
            name="password"
            autocomplete="current-password"
            class="w-full"
          />
        </UFormField>

        <UAlert
          v-if="formError"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="formError"
          aria-live="polite"
        />

        <UButton type="submit" block :loading="pending" :label="pending ? 'Signing In…' : 'Sign In'" />
      </UForm>
    </UCard>
  </div>
</template>
```

- [x] **Step 5: Audit against the Web Interface Guidelines**

Run the audit described in Appendix A over `app/layouts/dashboard.vue`, `app/pages/login.vue`. Fix every finding before proceeding. Expected clean result: no findings.

- [x] **Step 6: Commit**

```bash
git add app/
git commit -m "feat: add dashboard shell and sign-in page"
```

---

### Task B4: Project list

**Files:**
- Create: `app/pages/index.vue`, `app/components/EmptyState.vue`
- Test: audit in Step 4

- [x] **Step 1: Build the empty state**

```vue
<!-- app/components/EmptyState.vue -->
<script setup lang="ts">
defineProps<{ icon: string; title: string; description: string }>()
</script>

<template>
  <div class="rounded-lg border border-dashed border-default px-6 py-16 text-center">
    <UIcon :name="icon" class="mx-auto size-8 text-muted" aria-hidden="true" />
    <h2 class="mt-4 font-medium">{{ title }}</h2>
    <p class="mx-auto mt-1 max-w-sm text-sm text-muted text-pretty">{{ description }}</p>
    <div class="mt-6"><slot /></div>
  </div>
</template>
```

- [x] **Step 2: Build the page**

```vue
<!-- app/pages/index.vue -->
<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: 'Projects · statesman' })

type ProjectRow = {
  id: string; slug: string; name: string; org: string
  updatedAt: string | null; serial: number | null; sizeBytes: number | null
  lockedBy: string | null; versionCount: number
}

const { data: projects, status } = await useFetch<ProjectRow[]>('/api/ui/projects')

const bytes = new Intl.NumberFormat(undefined, {
  notation: 'compact', style: 'unit', unit: 'byte', unitDisplay: 'narrow'
})
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between gap-4">
      <h1 class="text-xl font-semibold tracking-tight text-balance">Projects</h1>
      <UBadge v-if="projects?.length" color="neutral" variant="subtle">
        {{ projects.length }}
      </UBadge>
    </div>

    <div v-if="status === 'pending'" class="space-y-3" aria-live="polite" aria-busy="true">
      <USkeleton v-for="n in 3" :key="n" class="h-20 w-full" />
      <span class="sr-only">Loading Projects…</span>
    </div>

    <EmptyState
      v-else-if="!projects?.length"
      icon="i-lucide-boxes"
      title="No Projects Yet"
      description="A project appears here the first time Terraform writes state to it. Create a token, point a backend block at statesman, and run apply."
    >
      <UButton to="/tokens" label="Create a Token" icon="i-lucide-key-round" />
    </EmptyState>

    <ul v-else class="grid gap-3">
      <li v-for="p in projects" :key="p.id">
        <NuxtLink
          :to="`/projects/${p.org}/${p.slug}`"
          class="block rounded-lg border border-default p-4 transition-colors hover:border-primary hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="min-w-0 truncate font-medium">{{ p.org }}/{{ p.slug }}</span>
            <UBadge
              v-if="p.lockedBy"
              color="warning"
              variant="subtle"
              icon="i-lucide-lock"
              :label="`Locked by ${p.lockedBy}`"
            />
          </div>
          <dl class="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted tabular">
            <div class="flex gap-1.5">
              <dt>Serial</dt><dd>{{ p.serial ?? '—' }}</dd>
            </div>
            <div class="flex gap-1.5">
              <dt>Versions</dt><dd>{{ p.versionCount }}</dd>
            </div>
            <div class="flex gap-1.5">
              <dt>Size</dt><dd>{{ p.sizeBytes === null ? '—' : bytes.format(p.sizeBytes) }}</dd>
            </div>
            <div class="flex gap-1.5">
              <dt>Updated</dt>
              <dd>
                <ClientOnly fallback="—">
                  {{ p.updatedAt ? when.format(new Date(p.updatedAt)) : '—' }}
                </ClientOnly>
              </dd>
            </div>
          </dl>
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
```

`ClientOnly` around the formatted timestamp is not decoration — `Intl.DateTimeFormat` resolves against the runtime's locale and time zone, which differ between the server and the browser and would otherwise produce a hydration mismatch.

- [x] **Step 3: Verify manually**

```bash
pnpm dev
```
Open http://localhost:3000. Confirm: the empty state shows with no projects; a seeded project renders; keyboard Tab reaches every card and shows a visible focus ring.

- [x] **Step 4: Audit against the Web Interface Guidelines**

Audit `app/pages/index.vue`, `app/components/EmptyState.vue`. Fix every finding.

- [x] **Step 5: Commit**

```bash
git add app/
git commit -m "feat: add project list page"
```

---

### Task B5: Version timeline and force-unlock

**Files:**
- Create: `app/pages/projects/[org]/[project]/index.vue`, `app/components/LockBanner.vue`
- Test: audit in Step 4

`index.vue` inside the `[project]` directory, not `[project].vue` beside it. Nuxt
treats a `[project].vue` sitting next to a `[project]/` directory as a nested-route
parent and will not render `diff.vue` (Task B6) without a `<NuxtPage />` in it.
Directory-plus-`index.vue` keeps both routes flat and independent.

- [x] **Step 1: Build the lock banner**

```vue
<!-- app/components/LockBanner.vue -->
<script setup lang="ts">
const props = defineProps<{ projectId: string; who: string | null; since: string | null }>()
const emit = defineEmits<{ released: [] }>()

const open = ref(false)
const pending = ref(false)

async function forceUnlock() {
  pending.value = true
  try {
    await $fetch(`/api/ui/projects/${props.projectId}/lock`, { method: 'DELETE' })
    emit('released')
    open.value = false
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <UAlert
    color="warning"
    variant="subtle"
    icon="i-lucide-lock"
    title="State Is Locked"
    :description="`Held by ${who ?? 'an unknown process'}. Terraform will refuse to apply until it is released.`"
    aria-live="polite"
  >
    <template #actions>
      <UButton color="warning" variant="outline" label="Force Unlock" @click="open = true" />
    </template>
  </UAlert>

  <UModal v-model:open="open" title="Force Unlock This State?">
    <template #body>
      <p class="text-sm text-muted text-pretty">
        Force-unlocking while another process is mid-apply can corrupt your state file.
        Only do this when you are certain the holder has died. This action is recorded
        in the audit log.
      </p>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton
          color="error"
          :loading="pending"
          :label="pending ? 'Unlocking…' : 'Force Unlock'"
          @click="forceUnlock"
        />
      </div>
    </template>
  </UModal>
</template>
```

- [x] **Step 2: Build the timeline page**

```vue
<!-- app/pages/projects/[org]/[project]/index.vue -->
<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const org = computed(() => String(route.params.org))
const slug = computed(() => String(route.params.project))
useHead({ title: () => `${org.value}/${slug.value} · statesman` })

type ProjectRow = { id: string; slug: string; org: string; lockedBy: string | null }
type Version = {
  id: string; serial: number | null; lineage: string | null
  sizeBytes: number; md5: string; createdAt: string
  authorName: string | null; authorEmail: string | null
}

const { data: projects } = await useFetch<ProjectRow[]>('/api/ui/projects')
const current = computed(() =>
  projects.value?.find((p) => p.org === org.value && p.slug === slug.value) ?? null
)

const { data: history, refresh } = await useFetch<{
  currentVersionId: string | null; versions: Version[]
}>(() => `/api/ui/projects/${current.value?.id}/versions`, {
  immediate: false,
  watch: [current]
})

// Compare selection lives in the URL so a comparison is shareable.
const compareA = computed({
  get: () => (route.query.a as string) ?? '',
  set: (v) => navigateTo({ query: { ...route.query, a: v || undefined } })
})
const compareB = computed({
  get: () => (route.query.b as string) ?? '',
  set: (v) => navigateTo({ query: { ...route.query, b: v || undefined } })
})

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const bytes = new Intl.NumberFormat(undefined, {
  notation: 'compact', style: 'unit', unit: 'byte', unitDisplay: 'narrow'
})
</script>

<template>
  <div class="space-y-6">
    <UBreadcrumb
      :items="[
        { label: 'Projects', to: '/' },
        { label: `${org}/${slug}` }
      ]"
    />

    <h1 class="text-xl font-semibold tracking-tight text-balance">{{ org }}/{{ slug }}</h1>

    <LockBanner
      v-if="current?.lockedBy"
      :project-id="current.id"
      :who="current.lockedBy"
      :since="null"
      @released="refresh()"
    />

    <EmptyState
      v-if="history && history.versions.length === 0"
      icon="i-lucide-history"
      title="No Versions Yet"
      description="Run terraform apply against this project and the first version appears here."
    />

    <div v-else-if="history" class="space-y-3">
      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="Compare" name="compare-a" class="w-48">
          <USelect
            v-model="compareA"
            :items="history.versions.map((v) => ({ label: `#${v.serial ?? '?'}`, value: v.id }))"
            placeholder="Older version…"
          />
        </UFormField>
        <UFormField label="With" name="compare-b" class="w-48">
          <USelect
            v-model="compareB"
            :items="history.versions.map((v) => ({ label: `#${v.serial ?? '?'}`, value: v.id }))"
            placeholder="Newer version…"
          />
        </UFormField>
        <UButton
          :disabled="!compareA || !compareB || compareA === compareB"
          :to="`/projects/${org}/${slug}/diff?a=${compareA}&b=${compareB}`"
          label="View Diff"
          icon="i-lucide-git-compare"
        />
      </div>

      <ol class="space-y-2">
        <li
          v-for="v in history.versions"
          :key="v.id"
          class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-default px-4 py-3"
        >
          <UBadge
            v-if="v.id === history.currentVersionId"
            color="success"
            variant="subtle"
            label="Current"
          />
          <span class="font-medium tabular">#{{ v.serial ?? '—' }}</span>
          <span class="min-w-0 truncate text-sm text-muted">
            {{ v.authorName ?? v.authorEmail ?? 'Unknown' }}
          </span>
          <span class="text-sm text-muted tabular">
            <ClientOnly fallback="—">{{ when.format(new Date(v.createdAt)) }}</ClientOnly>
          </span>
          <span class="text-sm text-muted tabular">{{ bytes.format(v.sizeBytes) }}</span>
        </li>
      </ol>
    </div>
  </div>
</template>
```

- [x] **Step 3: Verify manually**

Confirm the lock banner appears when a lock row exists, that Force Unlock asks for confirmation before acting, and that selecting two versions puts `?a=…&b=…` in the URL so the comparison can be shared.

- [x] **Step 4: Add the rollback action**

Each non-current row gets a rollback button. It calls `POST /api/admin/rollback`
(built by Lane A, Task A6) and, because rollback overwrites what Terraform will
next read, it confirms first:

```vue
<UButton
  v-if="v.id !== history.currentVersionId"
  class="ms-auto"
  color="neutral"
  variant="ghost"
  size="xs"
  icon="i-lucide-rotate-ccw"
  :aria-label="`Roll back to version ${v.serial ?? v.id}`"
  @click="pendingRollback = v"
/>
```

```vue
<UModal
  :open="pendingRollback !== null"
  title="Roll Back to This Version?"
  @update:open="(open) => { if (!open) pendingRollback = null }"
>
  <template #body>
    <p class="text-sm text-muted text-pretty">
      This writes the contents of version #{{ pendingRollback?.serial ?? '—' }} as a new
      version. Nothing is deleted and the timeline keeps every entry. The next
      terraform plan will read the restored state.
    </p>
  </template>
  <template #footer>
    <div class="flex justify-end gap-2">
      <UButton color="neutral" variant="ghost" label="Cancel" @click="pendingRollback = null" />
      <UButton
        color="primary"
        :loading="rollingBack"
        :label="rollingBack ? 'Rolling Back…' : 'Roll Back'"
        @click="rollback"
      />
    </div>
  </template>
</UModal>
```

```ts
const pendingRollback = ref<Version | null>(null)
const rollingBack = ref(false)

async function rollback() {
  if (!pendingRollback.value || !current.value) return
  rollingBack.value = true
  try {
    await $fetch('/api/admin/rollback', {
      method: 'POST',
      body: { projectId: current.value.id, versionId: pendingRollback.value.id }
    })
    pendingRollback.value = null
    await refresh()
  } finally {
    rollingBack.value = false
  }
}
```

- [x] **Step 5: Audit against the Web Interface Guidelines**

Audit `app/pages/projects/[org]/[project]/index.vue`, `app/components/LockBanner.vue`. Fix every finding.

- [x] **Step 6: Commit**

```bash
git add app/
git commit -m "feat: add version timeline with force unlock and rollback"
```

---

### Task B6: State diff

**Files:**
- Create: `app/pages/projects/[org]/[project]/diff.vue`, `app/components/StateDiff.vue`, `app/utils/diff.ts`
- Test: `tests/ui/diff.test.ts`

**Interfaces:**
- Produces: `function diffJson(a: unknown, b: unknown): DiffLine[]` where `DiffLine = { kind: 'add' | 'remove' | 'same'; path: string; value: string }`

- [x] **Step 1: Write the failing test**

```ts
// tests/ui/diff.test.ts
import { describe, it, expect } from 'vitest'
import { diffJson } from '../../app/utils/diff'

describe('diffJson', () => {
  it('reports no changes for identical documents', () => {
    const doc = { a: 1, b: 'x' }
    expect(diffJson(doc, { ...doc }).filter((l) => l.kind !== 'same')).toHaveLength(0)
  })

  it('detects an added key', () => {
    const changes = diffJson({ a: 1 }, { a: 1, b: 2 })
    expect(changes).toContainEqual({ kind: 'add', path: 'b', value: '2' })
  })

  it('detects a removed key', () => {
    const changes = diffJson({ a: 1, b: 2 }, { a: 1 })
    expect(changes).toContainEqual({ kind: 'remove', path: 'b', value: '2' })
  })

  it('detects a changed value as a remove plus an add', () => {
    const changes = diffJson({ a: 1 }, { a: 2 })
    expect(changes).toContainEqual({ kind: 'remove', path: 'a', value: '1' })
    expect(changes).toContainEqual({ kind: 'add', path: 'a', value: '2' })
  })

  it('walks into nested objects and arrays', () => {
    const changes = diffJson(
      { resources: [{ name: 'db', id: 'old' }] },
      { resources: [{ name: 'db', id: 'new' }] }
    )
    expect(changes.some((l) => l.path === 'resources.0.id' && l.kind === 'add')).toBe(true)
  })

  it('handles null on either side', () => {
    expect(() => diffJson(null, { a: 1 })).not.toThrow()
  })
})
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run tests/ui/diff.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

```ts
// app/utils/diff.ts
export type DiffLine = { kind: 'add' | 'remove' | 'same'; path: string; value: string }

function flatten(value: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (value === null || typeof value !== 'object') {
    out.set(prefix, JSON.stringify(value) ?? 'undefined')
    return out
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    out.set(prefix, Array.isArray(value) ? '[]' : '{}')
    return out
  }
  for (const [key, child] of entries) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out)
  }
  return out
}

export function diffJson(a: unknown, b: unknown): DiffLine[] {
  const left = flatten(a)
  const right = flatten(b)
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort()

  const lines: DiffLine[] = []
  for (const path of paths) {
    const before = left.get(path)
    const after = right.get(path)
    if (before === after) {
      lines.push({ kind: 'same', path, value: after ?? '' })
      continue
    }
    if (before !== undefined) lines.push({ kind: 'remove', path, value: before })
    if (after !== undefined) lines.push({ kind: 'add', path, value: after })
  }
  return lines
}
```

- [x] **Step 4: Build the diff component**

```vue
<!-- app/components/StateDiff.vue -->
<script setup lang="ts">
import type { DiffLine } from '~/utils/diff'

const props = defineProps<{ lines: DiffLine[] }>()
const showUnchanged = ref(false)

const visible = computed(() =>
  showUnchanged.value ? props.lines : props.lines.filter((l) => l.kind !== 'same')
)
const changeCount = computed(() => props.lines.filter((l) => l.kind !== 'same').length)
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm text-muted">
        {{ changeCount }} {{ changeCount === 1 ? 'change' : 'changes' }}
      </p>
      <USwitch v-model="showUnchanged" label="Show Unchanged Lines" />
    </div>

    <div
      v-if="visible.length === 0"
      class="rounded-lg border border-dashed border-default px-6 py-12 text-center text-sm text-muted"
    >
      These Two Versions Are Identical
    </div>

    <div v-else class="overflow-x-auto rounded-lg border border-default">
      <table class="w-full min-w-[36rem] text-left font-mono text-xs">
        <caption class="sr-only">Differences between the two selected state versions</caption>
        <thead class="sr-only">
          <tr><th scope="col">Change</th><th scope="col">Path</th><th scope="col">Value</th></tr>
        </thead>
        <tbody>
          <tr
            v-for="(line, index) in visible"
            :key="`${line.path}-${line.kind}-${index}`"
            :class="{
              'bg-success/10': line.kind === 'add',
              'bg-error/10': line.kind === 'remove'
            }"
          >
            <td class="w-6 select-none px-2 py-1 text-center text-muted" aria-hidden="true">
              {{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ' }}
            </td>
            <td class="px-2 py-1">
              <span class="sr-only">
                {{ line.kind === 'add' ? 'Added' : line.kind === 'remove' ? 'Removed' : 'Unchanged' }}:
              </span>
              <span class="break-words">{{ line.path }}</span>
            </td>
            <td class="min-w-0 px-2 py-1 break-words text-muted">{{ line.value }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
```

- [x] **Step 5: Build the diff page**

```vue
<!-- app/pages/projects/[org]/[project]/diff.vue -->
<script setup lang="ts">
import { diffJson } from '~/utils/diff'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const org = computed(() => String(route.params.org))
const slug = computed(() => String(route.params.project))
const a = computed(() => String(route.query.a ?? ''))
const b = computed(() => String(route.query.b ?? ''))

useHead({ title: () => `Diff · ${org.value}/${slug.value} · statesman` })

type VersionBody = { json: unknown; raw: string | null }

const { data: left, status: leftStatus } = await useFetch<VersionBody>(() => `/api/ui/versions/${a.value}`)
const { data: right, status: rightStatus } = await useFetch<VersionBody>(() => `/api/ui/versions/${b.value}`)

const lines = computed(() =>
  left.value && right.value ? diffJson(left.value.json, right.value.json) : []
)
const loading = computed(() => leftStatus.value === 'pending' || rightStatus.value === 'pending')
</script>

<template>
  <div class="space-y-6">
    <UBreadcrumb
      :items="[
        { label: 'Projects', to: '/' },
        { label: `${org}/${slug}`, to: `/projects/${org}/${slug}` },
        { label: 'Diff' }
      ]"
    />

    <h1 class="text-xl font-semibold tracking-tight text-balance">Compare Versions</h1>

    <div v-if="loading" aria-live="polite" aria-busy="true">
      <USkeleton class="h-64 w-full" />
      <span class="sr-only">Loading Versions…</span>
    </div>

    <StateDiff v-else :lines="lines" />
  </div>
</template>
```

- [x] **Step 6: Run tests and confirm they pass**

Run: `pnpm vitest run tests/ui/diff.test.ts`
Expected: 6 passed.

- [x] **Step 7: Audit against the Web Interface Guidelines**

Audit all three files. Fix every finding.

- [x] **Step 8: Commit**

```bash
git add app/ tests/ui/diff.test.ts
git commit -m "feat: add state version diff view"
```

---

### Task B7: Token configurator

**Files:**
- Create: `app/pages/tokens.vue`, `app/components/TokenConfigurator.vue`, `app/components/TokenRevealModal.vue`
- Test: audit in Step 4

- [x] **Step 1: Build the configurator**

```vue
<!-- app/components/TokenConfigurator.vue -->
<script setup lang="ts">
import { tokenConfigSchema, type TokenConfig } from '~~/shared/schemas/token'

const emit = defineEmits<{ created: [{ id: string; key: string; name: string }] }>()

const { data: projects } = await useFetch<{ org: string; slug: string }[]>('/api/ui/projects')

const state = reactive<Partial<TokenConfig>>({
  name: undefined,
  actions: ['read', 'write', 'lock'],
  scope: { kind: 'projects', projects: [] },
  expiresInDays: 90
})

const scopeKind = computed({
  get: () => state.scope?.kind ?? 'projects',
  set: (kind: 'all' | 'projects') => {
    state.scope = kind === 'all' ? { kind: 'all' } : { kind: 'projects', projects: [] }
  }
})

const selectedProjects = computed({
  get: () => (state.scope?.kind === 'projects' ? state.scope.projects : []),
  set: (projects: string[]) => { state.scope = { kind: 'projects', projects } }
})

const actionOptions = [
  { label: 'Read State', value: 'read', description: 'Required for terraform plan' },
  { label: 'Write State', value: 'write', description: 'Required for terraform apply' },
  { label: 'Lock State', value: 'lock', description: 'Required for any apply that locks' },
  { label: 'Delete State', value: 'delete', description: 'Required for terraform destroy' }
]

const pending = ref(false)
const formError = ref<string | null>(null)

async function onSubmit(event: { data: TokenConfig }) {
  pending.value = true
  formError.value = null
  try {
    const created = await $fetch<{ id: string; key: string; name: string }>('/api/ui/tokens', {
      method: 'POST',
      body: event.data
    })
    emit('created', created)
  } catch {
    formError.value = 'Could not create the token. Check the fields above and try again.'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <UForm :schema="tokenConfigSchema" :state="state" class="space-y-6" @submit="onSubmit">
    <UFormField
      label="Name"
      name="name"
      description="Identifies this token in the list. Use where it will run."
      required
    >
      <UInput
        v-model="state.name"
        name="token-name"
        autocomplete="off"
        :spellcheck="false"
        placeholder="ci-prod-deploy…"
        class="w-full"
      />
    </UFormField>

    <UFormField label="Allowed Operations" name="actions" required>
      <UCheckboxGroup v-model="state.actions" :items="actionOptions" />
    </UFormField>

    <UFormField label="Project Scope" name="scope">
      <URadioGroup
        v-model="scopeKind"
        :items="[
          { label: 'Specific Projects', value: 'projects', description: 'Recommended. A leaked token reaches only these.' },
          { label: 'All My Projects', value: 'all', description: 'Convenient, but a leak exposes every project.' }
        ]"
      />
    </UFormField>

    <UFormField
      v-if="scopeKind === 'projects'"
      label="Projects"
      name="scope.projects"
      description="Pick at least one."
      required
    >
      <USelectMenu
        v-model="selectedProjects"
        multiple
        searchable
        :items="(projects ?? []).map((p) => `${p.org}/${p.slug}`)"
        placeholder="Choose projects…"
        class="w-full"
      />
    </UFormField>

    <UFormField
      label="Expires After"
      name="expiresInDays"
      description="Leave empty for a token that never expires."
    >
      <UInputNumber v-model="state.expiresInDays" :min="1" :max="3650" class="w-full" />
    </UFormField>

    <UAlert
      v-if="formError"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :description="formError"
      aria-live="polite"
    />

    <UButton
      type="submit"
      :loading="pending"
      :label="pending ? 'Creating Token…' : 'Create Token'"
      icon="i-lucide-key-round"
    />
  </UForm>
</template>
```

- [x] **Step 2: Build the reveal modal**

```vue
<!-- app/components/TokenRevealModal.vue -->
<script setup lang="ts">
const props = defineProps<{ token: { key: string; name: string } | null }>()
const emit = defineEmits<{ close: [] }>()

const open = computed({
  get: () => props.token !== null,
  set: (value: boolean) => { if (!value) emit('close') }
})

const copied = ref(false)
async function copy() {
  if (!props.token) return
  await navigator.clipboard.writeText(props.token.key)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

// useRequestURL works on both server and client; `window` would crash during SSR.
const origin = useRequestURL().origin

const backendSnippet = computed(() => `terraform {
  backend "http" {
    address        = "${origin}/api/tf/ORG/PROJECT"
    lock_address   = "${origin}/api/tf/ORG/PROJECT/lock"
    unlock_address = "${origin}/api/tf/ORG/PROJECT/lock"
    lock_method    = "POST"
    unlock_method  = "DELETE"
    username       = "statesman"
    password       = "${props.token?.key ?? ''}"
  }
}`)
</script>

<template>
  <UModal v-model:open="open" title="Copy Your Token Now" :dismissible="false">
    <template #body>
      <div class="space-y-4">
        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          description="This is the only time the token is shown. Copy it before closing this dialog — it cannot be retrieved later."
        />

        <div class="flex gap-2">
          <UInput :model-value="token?.key" readonly class="w-full font-mono" @focus="(e) => e.target.select()" />
          <UButton
            :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            :color="copied ? 'success' : 'neutral'"
            variant="outline"
            :aria-label="copied ? 'Token copied to clipboard' : 'Copy token to clipboard'"
            @click="copy"
          />
        </div>
        <p aria-live="polite" class="sr-only">{{ copied ? 'Token copied to clipboard' : '' }}</p>

        <div>
          <h3 class="mb-2 text-sm font-medium">Backend Configuration</h3>
          <pre class="overflow-x-auto rounded-lg bg-muted p-3 text-xs"><code>{{ backendSnippet }}</code></pre>
        </div>
      </div>
    </template>
    <template #footer>
      <UButton label="I Have Copied It" block @click="emit('close')" />
    </template>
  </UModal>
</template>
```

- [x] **Step 3: Build the page**

```vue
<!-- app/pages/tokens.vue -->
<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: 'Tokens · statesman' })

type TokenRow = {
  id: string; name: string | null; start: string | null
  enabled: boolean; expiresAt: string | null; lastRequest: string | null
}

const { data: tokens, refresh } = await useFetch<TokenRow[]>('/api/ui/tokens')
const revealed = ref<{ id: string; key: string; name: string } | null>(null)
const creating = ref(false)

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

async function revoke(id: string) {
  await $fetch(`/api/ui/tokens/${id}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between gap-4">
      <h1 class="text-xl font-semibold tracking-tight text-balance">Tokens</h1>
      <UButton icon="i-lucide-plus" label="New Token" @click="creating = true" />
    </div>

    <EmptyState
      v-if="!tokens?.length"
      icon="i-lucide-key-round"
      title="No Tokens Yet"
      description="Terraform authenticates with a token. Create one, then paste it into the password field of your backend block."
    >
      <UButton icon="i-lucide-plus" label="Create Your First Token" @click="creating = true" />
    </EmptyState>

    <ul v-else class="grid gap-2">
      <li
        v-for="t in tokens"
        :key="t.id"
        class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-default px-4 py-3"
      >
        <span class="min-w-0 truncate font-medium">{{ t.name ?? 'Unnamed' }}</span>
        <code class="text-xs text-muted">{{ t.start }}…</code>
        <UBadge
          :color="t.enabled ? 'success' : 'neutral'"
          variant="subtle"
          :label="t.enabled ? 'Active' : 'Disabled'"
        />
        <span v-if="t.expiresAt" class="text-sm text-muted tabular">
          <ClientOnly fallback="—">Expires {{ when.format(new Date(t.expiresAt)) }}</ClientOnly>
        </span>
        <UButton
          class="ms-auto"
          color="error"
          variant="ghost"
          icon="i-lucide-trash-2"
          :aria-label="`Revoke token ${t.name ?? 'Unnamed'}`"
          @click="revoke(t.id)"
        />
      </li>
    </ul>

    <USlideover v-model:open="creating" title="New Token">
      <template #body>
        <TokenConfigurator
          @created="(token) => { revealed = token; creating = false; refresh() }"
        />
      </template>
    </USlideover>

    <TokenRevealModal :token="revealed" @close="revealed = null" />
  </div>
</template>
```

- [x] **Step 4: Audit against the Web Interface Guidelines**

Audit all three files. Fix every finding. Pay particular attention to: the copy-to-clipboard confirmation being announced via `aria-live`; the revoke button carrying a per-row `aria-label`; and the reveal modal being non-dismissible so the token cannot be lost by a stray click.

- [x] **Step 5: Commit**

```bash
git add app/
git commit -m "feat: add token configurator with one-time reveal"
```

---

## Lane B exit gate

```bash
pnpm vitest run tests/ui
pnpm nuxt build
pnpm vue-tsc --noEmit
```

Plus: a clean Web Interface Guidelines audit across all of `app/**`.

---

# PHASE 2 — Integration

**Runs after both lanes merge.** One agent.

---

### Task C1: Local development stack

**Files:**
- Create: `docker-compose.yml`, `.env.example`, `scripts/seed.ts`
- Modify: `package.json` scripts

- [x] **Step 1: Complete the compose file**

Task 0.3 created a minimal version of this file. Replace it with the full stack:

```yaml
# docker-compose.yml — local development
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: statesman
      POSTGRES_PASSWORD: statesman
      POSTGRES_DB: statesman
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U statesman']
      interval: 5s
      timeout: 5s
      retries: 10

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports: ['9000:9000', '9001:9001']
    volumes: ['miniodata:/data']
    healthcheck:
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  pgdata:
  miniodata:
```

- [x] **Step 2: Write `.env.example`**

```bash
# .env.example
DATABASE_URL=postgres://statesman:statesman@localhost:5432/statesman
DB_DRIVER=node

STORAGE_DRIVER=local
LOCAL_STORAGE_PATH=./.data/state

# For the s3 driver against local MinIO:
# STORAGE_DRIVER=s3
# S3_BUCKET=statesman
# S3_ENDPOINT=http://localhost:9000
# S3_REGION=us-east-1
# S3_FORCE_PATH_STYLE=true
# S3_ACCESS_KEY_ID=minioadmin
# S3_SECRET_ACCESS_KEY=minioadmin

# Required. Generate with: pnpm gen:key
STATESMAN_ENCRYPTION_KEY=

# Required. Generate with: openssl rand -base64 32
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000

RETENTION_KEEP_VERSIONS=100
RETENTION_KEEP_DAYS=30
```

- [x] **Step 3: Write the seed script**

```ts
// scripts/seed.ts
import { ulid } from 'ulid'
import { db } from '../server/db/client'
import { organization } from '../server/db/schema'

const [existing] = await db().select().from(organization).limit(1)
if (existing) {
  console.log(`Organization already seeded: ${existing.slug}`)
  process.exit(0)
}

const slug = process.env.STATESMAN_ORG_SLUG ?? 'acme'
await db().insert(organization).values({ id: ulid(), name: slug, slug })
console.log(`Seeded organization: ${slug}`)
```

- [x] **Step 4: Add scripts**

```json
"scripts": {
  "dev": "nuxt dev",
  "build": "nuxt build",
  "gen:key": "node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"",
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate",
  "db:seed": "tsx scripts/seed.ts",
  "test": "vitest run",
  "test:e2e": "vitest run tests/e2e",
  "typecheck": "vue-tsc --noEmit",
  "setup": "docker compose up -d && pnpm db:migrate && pnpm db:seed"
}
```

- [x] **Step 5: Verify end to end**

```bash
cp .env.example .env
pnpm gen:key   # paste into STATESMAN_ENCRYPTION_KEY
pnpm setup
pnpm dev
```
Expected: the app boots, sign-up works, the project list renders its empty state.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: add local development stack"
```

---

### Task C2: Real Terraform acceptance test

This is the test that settles whether the protocol implementation is correct. Everything before it verifies our beliefs about the protocol against each other; only this verifies them against Terraform.

**Files:**
- Create: `tests/e2e/terraform.test.ts`, `tests/e2e/fixture/main.tf`
- Test: itself

- [x] **Step 1: Write the Terraform fixture**

```hcl
# tests/e2e/fixture/main.tf
terraform {
  required_version = ">= 1.6"
  backend "http" {}
}

resource "terraform_data" "canary" {
  input = var.value
}

variable "value" {
  type    = string
  default = "one"
}

output "value" {
  value = terraform_data.canary.output
}
```

- [x] **Step 2: Write the failing test**

```ts
// tests/e2e/terraform.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup, useTestContext } from '@nuxt/test-utils/e2e'
import { auth } from '../../server/utils/auth'
import { seedProject, resetDb } from '../protocol/helpers'

const run = promisify(execFile)
await setup({ server: true })

let dir: string
let token: string
let base: string

async function tf(...args: string[]) {
  return run('terraform', args, {
    cwd: dir,
    env: {
      ...process.env,
      TF_IN_AUTOMATION: '1',
      TF_INPUT: '0',
      TF_HTTP_ADDRESS: `${base}/api/tf/acme/prod`,
      TF_HTTP_LOCK_ADDRESS: `${base}/api/tf/acme/prod/lock`,
      TF_HTTP_UNLOCK_ADDRESS: `${base}/api/tf/acme/prod/lock`,
      TF_HTTP_LOCK_METHOD: 'POST',
      TF_HTTP_UNLOCK_METHOD: 'DELETE',
      TF_HTTP_USERNAME: 'statesman',
      TF_HTTP_PASSWORD: token
    }
  })
}

beforeAll(async () => {
  base = useTestContext().url!.replace(/\/$/, '')
  await resetDb()
  await seedProject('acme', 'prod')

  const user = await auth.api.signUpEmail({
    body: { email: `tf${Date.now()}@example.com`, password: 'correct horse battery', name: 'TF' }
  })
  const key = await auth.api.createApiKey({
    body: {
      userId: user.user.id,
      name: 'terraform-e2e',
      permissions: { state: ['read', 'write', 'delete', 'lock'] },
      metadata: { scope: { kind: 'projects', projects: ['acme/prod'] } }
    }
  })
  token = key.key

  dir = await mkdtemp(join(tmpdir(), 'statesman-tf-'))
  await cp(join(import.meta.dirname, 'fixture'), dir, { recursive: true })
}, 120_000)

describe('real terraform', () => {
  it('initialises against the http backend', async () => {
    const { stdout } = await tf('init', '-no-color')
    expect(stdout).toContain('Terraform has been successfully initialized')
  }, 120_000)

  it('applies and persists state', async () => {
    await tf('apply', '-auto-approve', '-no-color')
    const { stdout } = await tf('output', '-raw', 'value')
    expect(stdout.trim()).toBe('one')
  }, 120_000)

  it('reads back the same state in a fresh plan', async () => {
    const { stdout } = await tf('plan', '-no-color', '-detailed-exitcode')
      .catch((e: { stdout: string; code: number }) => ({ stdout: e.stdout }))
    expect(stdout).toContain('No changes')
  }, 120_000)

  it('records a second version on the next apply', async () => {
    await tf('apply', '-auto-approve', '-no-color', '-var', 'value=two')
    const { stdout } = await tf('output', '-raw', 'value')
    expect(stdout.trim()).toBe('two')
  }, 120_000)

  it('reports the holder when the state is already locked', async () => {
    await $fetch(`${base}/api/tf/acme/prod/lock`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` },
      body: { ID: 'held-by-test', Who: 'another-engineer@laptop' }
    })
    await expect(tf('apply', '-auto-approve', '-no-color')).rejects.toThrow(/another-engineer@laptop/)
    await $fetch(`${base}/api/tf/acme/prod/lock`, {
      method: 'DELETE',
      headers: { authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` },
      body: { ID: 'held-by-test' }
    })
  }, 120_000)

  it('destroys cleanly', async () => {
    const { stdout } = await tf('destroy', '-auto-approve', '-no-color')
    expect(stdout).toContain('Destroy complete')
  }, 120_000)
})
```

- [x] **Step 3: Run it**

```bash
terraform version   # install if missing: brew install terraform
pnpm vitest run tests/e2e/terraform.test.ts
```
Expected: 6 passed.

The lock test is the one that matters most. If Terraform prints the holder's name, the 423 response body is correctly shaped. If it prints a generic error, the body is wrong even though every unit test passed.

- [x] **Step 4: Commit**

```bash
git add tests/e2e
git commit -m "test: verify the protocol against the real terraform cli"
```

---

### Task C3: Production deployment

**Files:**
- Create: `Dockerfile`, `docker-compose.prod.yml`, `vercel.json`, `.dockerignore`

- [x] **Step 1: Write the Dockerfile**

```dockerfile
# Dockerfile
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
RUN corepack enable && addgroup -S app && adduser -S app -G app
COPY --from=build /app/.output ./.output
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./
USER app
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
```

- [x] **Step 2: Write the production compose file**

```yaml
# docker-compose.prod.yml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-statesman}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      POSTGRES_DB: ${POSTGRES_DB:-statesman}
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER:-statesman}']
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  migrate:
    build: .
    command: ['npx', 'drizzle-kit', 'migrate']
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
    depends_on:
      postgres: { condition: service_healthy }
    restart: 'no'

  app:
    build: .
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
      DB_DRIVER: node
      STORAGE_DRIVER: ${STORAGE_DRIVER:-local}
      LOCAL_STORAGE_PATH: /data/state
      S3_BUCKET: ${S3_BUCKET:-}
      S3_ENDPOINT: ${S3_ENDPOINT:-}
      S3_REGION: ${S3_REGION:-us-east-1}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:-}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:-}
      STATESMAN_ENCRYPTION_KEY: ${STATESMAN_ENCRYPTION_KEY:?STATESMAN_ENCRYPTION_KEY is required}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET is required}
      BETTER_AUTH_URL: ${BETTER_AUTH_URL:?BETTER_AUTH_URL is required}
    volumes: ['statedata:/data/state']
    ports: ['3000:3000']
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    depends_on:
      migrate: { condition: service_completed_successfully }
    restart: unless-stopped

volumes:
  pgdata:
  statedata:
```

The `:?` syntax fails the deployment at startup when a required secret is missing, rather than starting an app that cannot work.

- [x] **Step 3: Write the Vercel config**

```json
{
  "buildCommand": "pnpm drizzle-kit migrate && pnpm build",
  "framework": "nuxtjs"
}
```

- [x] **Step 4: Verify both paths**

```bash
docker compose -f docker-compose.prod.yml config    # no errors
docker compose -f docker-compose.prod.yml up --build -d
curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:3000   # 200 or 302
docker compose -f docker-compose.prod.yml down
```

- [x] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.prod.yml vercel.json .dockerignore
git commit -m "chore: add docker and vercel deployment configuration"
```

---

### Task C4: Documentation

**Files:**
- Create: `README.md`, `docs/deploy-docker.md`, `docs/deploy-vercel.md`, `docs/backend-config.md`

- [x] **Step 1: Write the README**

Must contain, in this order: what statesman is in two sentences; the three-command quickstart; a copy-pasteable `backend "http"` block; the `lock_method = "POST"` note and why; a prominent warning that losing `STATESMAN_ENCRYPTION_KEY` means losing all state, and that the key must be backed up separately from the database; and a comparison table against the `s3` backend that is honest about when S3 is the better choice.

- [x] **Step 2: Write the deployment guides**

`docs/deploy-docker.md` and `docs/deploy-vercel.md`, each with the full environment variable table and a verification step that ends in a real `terraform init`.

- [x] **Step 3: Commit**

```bash
git add README.md docs/
git commit -m "docs: add readme and deployment guides"
```

---

## Phase 2 exit gate

```bash
pnpm test          # every suite
pnpm test:e2e      # real terraform
pnpm typecheck
pnpm build
docker compose -f docker-compose.prod.yml config
```

---

# Appendix A — Web Interface Guidelines audit

Every Lane B task ends with this audit. Run it over the files that task created or modified.

**Procedure:**

1. Invoke the project's `web-design-guidelines` skill, or fetch the rules directly from
   `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`
2. Read every file the task touched.
3. Check against all rules.
4. Report findings as `file:line - issue`, grouped by file, no preamble.
5. **Fix every finding before the task is complete.** The audit is a gate, not a report.

**The rules most likely to bite in this project**, pre-empted so they are designed in rather than retrofitted:

| Rule | Where it applies here |
|---|---|
| Icon-only buttons need `aria-label` | Copy button, revoke button, account menu, color-mode toggle |
| Visible focus on every interactive element | Project cards are links — they need `focus-visible` rings |
| Flex children need `min-w-0` to truncate | Project name rows, token name rows |
| `font-variant-numeric: tabular-nums` for number columns | Serial, size, and version counts in the timeline |
| `text-wrap: balance` / `text-pretty` | Page headings and empty-state descriptions |
| URL reflects state | Diff selection lives in `?a=&b=`, not component state |
| Destructive actions need confirmation | Force-unlock and token revoke |
| Async updates need `aria-live="polite"` | Loading states, copy confirmation, form errors |
| Guard date rendering against hydration mismatch | Every `Intl.DateTimeFormat` call — wrap in `ClientOnly` |
| Inputs need `autocomplete` and a meaningful `name` | Login form, token name field |
| Disable spellcheck on codes and emails | Email field, token name field |
| Submit stays enabled until the request starts; show a spinner | All three forms |
| Loading states end with `…` | "Signing In…", "Creating Token…", "Loading Projects…" |
| Use `…` not `...`, curly quotes not straight | All copy, including placeholders |
| Title Case for headings and buttons | "Create Token", "Force Unlock", "No Projects Yet" |
| Error messages include the fix | "That email and password did not match. Check both and try again." |
| Wide content scrolls in its own container | The diff table — `overflow-x-auto`, never a horizontally scrolling page |
| Empty states must not render broken UI | Project list, version timeline, token list |
| `translate="no"` on brand names and code | "statesman", the backend snippet |
| Set `color-scheme` and `<meta name="theme-color">` | `main.css` and `nuxt.config.ts` |
| Semantic HTML before ARIA | `<ol>` for the timeline, `<dl>` for metadata, `<table>` for the diff |
| Skip link, hierarchical headings | Dashboard layout |

---

# Appendix B — Parallel dispatch brief

The orchestrator dispatches the two lanes as separate agents once `phase-0-complete` is tagged.

**Both agents receive:** this plan, the spec, and the tag to branch from.

**Lane A agent brief:**
> Implement Tasks A1–A6 from `docs/superpowers/plans/2026-09-04-statesman.md`, in order, TDD. You own `server/utils/tf-auth.ts`, `server/utils/tf-handler.ts`, `server/services/**`, `server/api/tf/**`, `server/api/admin/**`, `tests/protocol/**`. Do not create or modify any file outside that list. If you believe a Phase 0 file must change, stop and report rather than editing it. Exit when `pnpm vitest run tests/protocol` and `pnpm vue-tsc --noEmit` are both clean.

**Lane B agent brief:**
> Implement Tasks B1–B7 from `docs/superpowers/plans/2026-09-04-statesman.md`, in order, TDD where a test is specified. You own `app/**`, `server/api/ui/**`, `server/utils/ui-auth.ts`, `server/utils/token-mapping.ts`, `tests/ui/**`. Do not create or modify any file outside that list. Every task ends with the Appendix A audit, and findings are fixed before the task is complete. If you believe a Phase 0 file must change, stop and report rather than editing it. Exit when `pnpm vitest run tests/ui`, `pnpm nuxt build`, and `pnpm vue-tsc --noEmit` are clean and the audit reports no findings.

**Merge:** Lane A first (it has no dependency on Lane B), then Lane B. The disjoint file ownership means the merge should be conflict-free; if it is not, a lane violated its boundary and that is the bug to fix.
