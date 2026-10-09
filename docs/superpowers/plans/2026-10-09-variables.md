# statesman variables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store Terraform input variables encrypted per project and environment, deliver them as `.auto.tfvars.json` over a token-authenticated `GET`, and optionally discover declared variables from a GitHub repository through a GitHub App.

**Architecture:** Three new layers on the existing Nuxt 4 / Nitro app. (1) Data: `environment`, `variable`, `github_installation`, `repository_link` tables; values sealed with the existing AES-256-GCM key plus AAD. (2) Doors: a new `/api/vars/*` route behind the existing token guard with a new `vars` permission resource, and `/api/ui/*` routes behind the existing session/admin guards. (3) Discovery: a tree-sitter HCL parser (WASM, vendored into `server/assets/`) and a hand-rolled GitHub App client over an injectable `fetch`.

**Tech Stack:** Nuxt 4.5, Nitro, Drizzle 0.45 (node-pg and neon-http), Better Auth 1.7 + API Key plugin, Zod 4, Nuxt UI 4, Vitest 4 with `@nuxt/test-utils`, `web-tree-sitter` 0.27.1, `@tree-sitter-grammars/tree-sitter-hcl` 1.2.0.

**Spec:** `docs/superpowers/specs/2026-10-09-variables-design.md`. Executors read it before Task 0. The base spec is `docs/superpowers/specs/2026-09-04-statesman-design.md`.

## Global Constraints

- Variable name: `^[A-Za-z_][A-Za-z0-9_-]*$`, max 128 characters.
- Variable value: any JSON value, serialised size ≤ 64 KiB (`65536` bytes).
- Max 500 variables per environment.
- Environment slug: the existing `projectSlug` rule, reused, never restated.
- AAD for every variable seal: the UTF-8 bytes of `variable:<environmentId>:<name>`.
- `sensitive` defaults to `true`. No UI route ever returns a sensitive value, sealed or decrypted.
- Delivery: `GET /api/vars/:org/:project/:environment`, JSON body, `Cache-Control: no-store`, audited as `variables.read`.
- Token permission resource for variables: `vars`, sole action `read`. Existing tokens have no `vars` entry and must be refused.
- GitHub env vars are all-or-none: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`.
- GitHub App permissions: Contents read, Metadata read. Event: Push. statesman never writes to a repository.
- **Never install the npm package `tree-sitter-hcl`** (unscoped). It is a `0.0.1-security` placeholder. The grammar is `@tree-sitter-grammars/tree-sitter-hcl`.
- No interactive DB transactions (Neon HTTP has none). Multi-row changes must be single statements.
- Never use `any`. `as unknown as X` only where an existing file already does so for the same reason.
- No `window.confirm`/`alert`/`prompt`. Modals follow the existing `v-model:open` pattern (`ProjectCreateModal.vue`).
- Do not render a control with one option (environment switcher appears at ≥ 2 environments).
- Machine data (commit SHA, installation ids) goes in a closed "Technical details" disclosure; the SHA has a copy button.
- Commits: Conventional Commits. Stage explicit paths only, never `git add -A`.
- Each task ends with `pnpm lint && pnpm typecheck && pnpm test` green before its commit. Docker Postgres and MinIO must be up (`docker compose up -d --wait postgres minio`).

## Review Focus

1. **Unticking `sensitive` on an existing sensitive variable without supplying a new value** would make the old secret visible in the dashboard. Expect a 400 that says a new value is required. Test in Task 5.
2. **Saving a sensitive variable with the value field left empty** must keep the stored value, not store `""` and not fail. Test in Task 5 (service) and Task 7 (route).
3. **A plain-string value that looks like JSON** (`"3"`, `"true"`, `"null"`, `"[1]"`) must be delivered as a JSON string, not coerced. Test in Task 5 (service round trip) and Task 9 (the editor's string mode sends `JSON` strings unchanged).
4. **An HCL `.tfvars` import containing an expression** (`"${var.x}"`, `file("x")`, `local.y`) must be refused with its line number, never stored as a literal string. Test in Task 10.
5. **A sync of a linked directory that has no `.tf` files** (deleted, renamed, or the wrong path typed) must record an explaining `lastSyncError` and keep the previous declared set, not mark every variable Undeclared. Test in Task 13.

---

## File map

| Path | Responsibility | Task |
|---|---|---|
| `server/assets/wasm/web-tree-sitter.wasm`, `tree-sitter-hcl.wasm` | Vendored parser binaries, served as Nitro server assets | 0 |
| `tests/unit/wasm-vendored.test.ts` | Fails when vendored WASM drifts from `node_modules` | 0 |
| `server/utils/crypto.ts` | `seal`/`open` gain optional AAD | 1 |
| `server/db/schema.ts`, `drizzle/0002_*.sql` | Four new tables | 2 |
| `shared/schemas/variable.ts` | Names, values, limits, inputs, `DeclaredVariable`, `variableAad` | 3 |
| `server/utils/variable-status.ts` | Pure merge of stored and declared into table rows | 3 |
| `shared/schemas/token.ts`, `server/utils/token-mapping.ts`, `server/utils/tf-auth.ts`, `server/api/ui/tokens.get.ts` | `vars` permission resource | 4 |
| `server/services/variables.ts` | Environment and variable persistence, sealing, delivery read | 5 |
| `server/api/vars/[org]/[project]/[environment].get.ts` | Delivery | 6 |
| `server/api/ui/projects/[id]/environments.{get,post}.ts`, `server/api/ui/environments/**` | Dashboard routes | 7 |
| `app/components/TokenConfigurator.vue`, `app/pages/tokens.vue` | Token UI for `vars` | 8 |
| `app/components/Variables*.vue`, `EnvironmentCreateModal.vue`, project page | Variables tab | 9 |
| `server/hcl/toolkit.ts`, `server/hcl/index.ts` | Parse `variable` blocks and literal `.tfvars` | 10 |
| `server/utils/env.ts` | `GITHUB_APP` config, all-or-none | 11 |
| `server/github/client.ts`, `server/github/signature.ts` | App JWT, installation tokens, REST calls, webhook HMAC | 11 |
| `server/services/sync.ts` | Link, unlink, sync, push dispatch | 12, 13 |
| `server/api/github/*`, `server/api/ui/github/**`, link/sync routes | GitHub routes | 14, 15 |
| `app/components/RepositoryPanel.vue`, `RepositoryLinkModal.vue` | GitHub UI | 16 |
| `tests/e2e/variables.test.ts`, `tests/e2e/fixture-vars/main.tf` | Real `terraform apply` with delivered values | 17 |
| `README.md`, `docs/github-app.md`, deploy docs, `.env.example`, base spec | Manual | 18 |

---

### Task 0: Vendor the parser WASM and prove it ships

The parser was probed during planning: `web-tree-sitter` 0.27.1 with `@tree-sitter-grammars/tree-sitter-hcl` 1.2.0 parses `variable` blocks, heredocs, nested `type` expressions, `validation` blocks and literal `.tfvars` on Node, and sets `rootNode.hasError` on a syntax error. What is unproven is that the two `.wasm` files reach a deployed function. This task settles that before anything depends on it.

**Files:**
- Create: `server/assets/wasm/web-tree-sitter.wasm`, `server/assets/wasm/tree-sitter-hcl.wasm` (copied binaries)
- Create: `scripts/vendor-wasm.ts`
- Create: `tests/unit/wasm-vendored.test.ts`
- Modify: `package.json` (dependencies, one script)

**Interfaces:**
- Produces: Nitro server assets `assets:server` keys `wasm:web-tree-sitter.wasm` and `wasm:tree-sitter-hcl.wasm`. Task 10 reads them.

- [ ] **Step 1: Add the packages**

```bash
pnpm add web-tree-sitter@0.27.1
pnpm add -D @tree-sitter-grammars/tree-sitter-hcl@1.2.0
```

The grammar package declares a native build (`node-gyp-build`). Do not approve its build script if pnpm asks: only its `.wasm` is used, and only as the source the vendored copy is checked against.

- [ ] **Step 2: Write the failing drift test**

`tests/unit/wasm-vendored.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * The parser binaries are committed under server/assets so Nitro bundles them
 * into every preset, Vercel included. A committed binary can silently fall
 * behind the package that produced it; this fails the moment it does, and
 * `pnpm vendor:wasm` is the fix.
 */
const PAIRS: Array<[string, string]> = [
  ['web-tree-sitter.wasm', require.resolve('web-tree-sitter/web-tree-sitter.wasm')],
  [
    'tree-sitter-hcl.wasm',
    join(dirname(require.resolve('@tree-sitter-grammars/tree-sitter-hcl/package.json')), 'tree-sitter-hcl.wasm')
  ]
]

describe('vendored wasm', () => {
  it.each(PAIRS)('%s matches node_modules', (name, source) => {
    const vendored = readFileSync(join('server/assets/wasm', name))
    expect(vendored.equals(readFileSync(source))).toBe(true)
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm vitest run tests/unit/wasm-vendored.test.ts`
Expected: FAIL with `ENOENT … server/assets/wasm/web-tree-sitter.wasm`.

- [ ] **Step 4: Write the vendoring script**

`scripts/vendor-wasm.ts`:

```ts
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const target = 'server/assets/wasm'
mkdirSync(target, { recursive: true })
copyFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'), join(target, 'web-tree-sitter.wasm'))
copyFileSync(
  join(dirname(require.resolve('@tree-sitter-grammars/tree-sitter-hcl/package.json')), 'tree-sitter-hcl.wasm'),
  join(target, 'tree-sitter-hcl.wasm')
)
console.log(`copied parser wasm into ${target}`)
```

Add to `package.json` scripts: `"vendor:wasm": "tsx scripts/vendor-wasm.ts"`. Run `pnpm vendor:wasm`.

- [ ] **Step 5: Run the test to see it pass**

Run: `pnpm vitest run tests/unit/wasm-vendored.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Prove the assets ship in both presets**

Add a temporary route `server/api/_probe-wasm.get.ts` (deleted in step 7):

```ts
export default defineEventHandler(async () => {
  const storage = useStorage('assets:server')
  const a = await storage.getItemRaw<Uint8Array>('wasm:web-tree-sitter.wasm')
  const b = await storage.getItemRaw<Uint8Array>('wasm:tree-sitter-hcl.wasm')
  return { runtime: a?.byteLength ?? 0, grammar: b?.byteLength ?? 0 }
})
```

Run:

```bash
pnpm build && node .output/server/index.mjs &   # node-server preset
sleep 3 && curl -s localhost:3000/api/_probe-wasm; kill %1
NITRO_PRESET=vercel pnpm build
grep -rl "tree-sitter-hcl" .vercel/output/functions | head -3
```

Expected: the curl prints `{"runtime":210415,"grammar":92478}`. The `grep` lists at least one file under `.vercel/output/functions` (Nitro inlines server assets into the bundle). If either fails, stop: report it, and revise spec §9 "Parser" before Task 10.

- [ ] **Step 7: Remove the probe and commit**

```bash
rm server/api/_probe-wasm.get.ts && rm -rf .vercel
git add package.json pnpm-lock.yaml scripts/vendor-wasm.ts server/assets/wasm tests/unit/wasm-vendored.test.ts
git commit -m "chore: vendor the HCL parser wasm as server assets"
```

---

### Task 1: AAD on seal and open

**Files:**
- Modify: `server/utils/crypto.ts`
- Test: `tests/unit/crypto.test.ts`

**Interfaces:**
- Produces: `seal(key: Buffer, plaintext: Uint8Array, aad?: Uint8Array): Buffer`, `open(key: Buffer, sealed: Uint8Array, aad?: Uint8Array): Buffer`.

- [ ] **Step 1: Capture a golden ciphertext from the CURRENT code**

Before editing anything:

```bash
pnpm tsx -e "import {seal} from './server/utils/crypto.ts'; console.log(seal(Buffer.alloc(32, 7), Buffer.from('statesman golden')).toString('hex'))"
```

Paste the printed hex into the test below as `GOLDEN`.

- [ ] **Step 2: Write the failing tests**

Append to `tests/unit/crypto.test.ts`:

```ts
// Sealed by the code as it stood before AAD existed. Every state blob in every
// deployment has this shape; opening it without AAD must keep working forever.
const GOLDEN = '<paste hex from step 1>'

describe('crypto with associated data', () => {
  const aad = Buffer.from('variable:env1:db_password')

  it('round-trips with matching aad', () => {
    const plain = Buffer.from('"hunter2"')
    expect(open(key, seal(key, plain, aad), aad)).toEqual(plain)
  })

  it('rejects a different aad', () => {
    const sealed = seal(key, Buffer.from('"hunter2"'), aad)
    expect(() => open(key, sealed, Buffer.from('variable:env2:db_password'))).toThrow()
  })

  it('rejects aad-sealed data opened without aad', () => {
    const sealed = seal(key, Buffer.from('"hunter2"'), aad)
    expect(() => open(key, sealed)).toThrow()
  })

  it('still opens pre-aad ciphertext without aad', () => {
    const opened = open(Buffer.alloc(32, 7), Buffer.from(GOLDEN, 'hex'))
    expect(opened.toString('utf8')).toBe('statesman golden')
  })
})
```

- [ ] **Step 3: Run to see the aad tests fail**

Run: `pnpm vitest run tests/unit/crypto.test.ts`
Expected: "rejects a different aad" and "rejects aad-sealed data opened without aad" FAIL (the argument is ignored, so both open). The golden test passes.

- [ ] **Step 4: Implement**

In `server/utils/crypto.ts`, change the two signatures and add one line in each:

```ts
/**
 * Wire format: [12-byte IV][16-byte GCM tag][ciphertext].
 *
 * A fresh random IV per call is what makes two seals of identical plaintext
 * produce different bytes. Never reuse an IV with the same key.
 *
 * `aad` binds the ciphertext to where it is stored without being stored in it:
 * opening with any other aad, or none, throws. State blobs pass none; variables
 * pass their environment and name (variables spec §4).
 */
export function seal(key: Buffer, plaintext: Uint8Array, aad?: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  if (aad) cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}
```

In `open`, after `decipher.setAuthTag(tag)` and with the new third parameter `aad?: Uint8Array`:

```ts
  if (aad) decipher.setAAD(aad)
```

- [ ] **Step 5: Run to see all pass**

Run: `pnpm vitest run tests/unit/crypto.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add server/utils/crypto.ts tests/unit/crypto.test.ts
git commit -m "feat: bind sealed payloads to optional associated data"
```

---

### Task 2: Tables and migration

**Files:**
- Modify: `server/db/schema.ts`
- Create: `drizzle/0002_<generated>.sql` (generated)
- Modify: `tests/integration/db.test.ts`

**Interfaces:**
- Consumes: `DeclaredVariable` type. Define it here in `shared/schemas/variable.ts` as a minimal file, and Task 3 extends that file.
- Produces: Drizzle tables `environment`, `variable`, `githubInstallation`, `repositoryLink`, all added to the exported `schema` object.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/db.test.ts`, matching its existing imports of `db` and helpers (`seedProject`, `resetDb` from `../protocol/helpers`):

```ts
import { environment, variable } from '../../server/db/schema'

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
    await db().insert(variable).values({ id: 'var-db-2', ...row })
    await expect(db().insert(variable).values({ id: 'var-db-3', ...row })).rejects.toThrow()
  })

  it('defaults sensitive to true', async () => {
    const projectId = await seedProject(ORG, 'p')
    await db().insert(environment).values({ id: 'env-db-3', projectId, slug: 'dev' })
    await db().insert(variable).values({ id: 'var-db-4', environmentId: 'env-db-3', name: 'y', valueSealed: 'AAAA' })
    const [row] = await db().select().from(variable).where(eq(variable.id, 'var-db-4'))
    expect(row?.sensitive).toBe(true)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run tests/integration/db.test.ts`
Expected: FAIL. TypeScript/import error: `environment` is not exported from schema.

- [ ] **Step 3: Create the minimal shared type**

`shared/schemas/variable.ts`:

```ts
import { z } from 'zod'

/** One `variable` block as found in a linked repository on the last sync. */
export const declaredVariableSchema = z.object({
  name: z.string(),
  typeExpr: z.string().nullable(),
  hasDefault: z.boolean(),
  sensitive: z.boolean(),
  description: z.string().nullable(),
  file: z.string(),
  line: z.number().int().positive()
})
export type DeclaredVariable = z.infer<typeof declaredVariableSchema>
```

- [ ] **Step 4: Add the tables**

In `server/db/schema.ts`, add `import type { DeclaredVariable } from '../../shared/schemas/variable'` at the top, then after `auditLog`:

```ts
// --- Variables (variables spec §3) ------------------------------------------

export const environment = pgTable(
  'environment',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow()
  },
  (t) => [uniqueIndex('environment_project_slug_uq').on(t.projectId, t.slug)]
)

// `valueSealed` is base64 text, not bytea: Neon's HTTP driver sends parameters
// as JSON and returns bytea as a `\x…` string, so a binary column would need
// conversion per driver in both directions (variables spec §3).
export const variable = pgTable(
  'variable',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    valueSealed: text('value_sealed').notNull(),
    sensitive: boolean('sensitive').notNull().default(true),
    description: text('description'),
    updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  },
  (t) => [uniqueIndex('variable_environment_name_uq').on(t.environmentId, t.name)]
)

export const githubInstallation = pgTable('github_installation', {
  installationId: bigint('installation_id', { mode: 'number' }).primaryKey(),
  accountLogin: text('account_login').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow()
})

// `declared` is a column, not a table, so a sync replaces it and its metadata
// in one UPDATE — Neon HTTP has no transactions (variables spec §3).
export const repositoryLink = pgTable(
  'repository_link',
  {
    environmentId: text('environment_id')
      .primaryKey()
      .references(() => environment.id, { onDelete: 'cascade' }),
    installationId: bigint('installation_id', { mode: 'number' })
      .notNull()
      .references(() => githubInstallation.installationId, { onDelete: 'cascade' }),
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    repoFullName: text('repo_full_name').notNull(),
    ref: text('ref').notNull(),
    directory: text('directory').notNull().default(''),
    lastSyncedAt: timestamp('last_synced_at'),
    lastSyncedSha: text('last_synced_sha'),
    lastSyncError: text('last_sync_error'),
    declared: jsonb('declared').$type<DeclaredVariable[]>()
  },
  (t) => [index('repository_link_repo_ref_idx').on(t.repoId, t.ref)]
)
```

Add `environment, variable, githubInstallation, repositoryLink` to the `schema` object.

- [ ] **Step 5: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0002_*.sql` creating the four tables, two unique indexes, one index, and the FKs. Read it and confirm there is no `DROP` statement.

- [ ] **Step 6: Run to see it pass**

Run: `pnpm vitest run tests/integration/db.test.ts` (`scripts/test-db.ts` migrates the test DB; run `pnpm db:migrate:test` first if invoking vitest directly).
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/db/schema.ts shared/schemas/variable.ts drizzle tests/integration/db.test.ts
git commit -m "feat: add environment, variable and repository link tables"
```

---

### Task 3: Shared schemas and the status merge

**Files:**
- Modify: `shared/schemas/variable.ts`
- Create: `server/utils/variable-status.ts`
- Test: `tests/unit/variable-schemas.test.ts`, `tests/unit/variable-status.test.ts`

**Interfaces:**
- Produces (from `shared/schemas/variable.ts`):
  - `MAX_VALUE_BYTES = 65536`, `MAX_VARIABLES_PER_ENVIRONMENT = 500`
  - `variableNameSchema: z.ZodString`
  - `variableValueSchema`: JSON value ≤ 64 KiB, type `JsonValue`
  - `setVariableSchema` → `SetVariableInput = { value?: JsonValue; sensitive: boolean; description?: string | null }`
  - `importVariablesSchema` → `ImportVariablesInput = { dryRun: boolean } & ({ values: Record<string, JsonValue> } | { hcl: string })`
  - `createEnvironmentSchema` → `{ slug: string }`
  - `variableAad(environmentId: string, name: string): Buffer`
- Produces (from `server/utils/variable-status.ts`):
  - `type VariableStatus = 'missing' | 'set' | 'optional' | 'undeclared'`
  - `type StoredVariable = { name: string; sensitive: boolean; description: string | null; value?: JsonValue; updatedAt: Date; updatedBy: string | null }`
  - `type VariableRow = { name: string; status: VariableStatus | null; stored: boolean; sensitive: boolean; value?: JsonValue; description: string | null; updatedAt: string | null; updatedBy: string | null; declared: DeclaredVariable | null }`
  - `mergeVariables(stored: StoredVariable[], declared: DeclaredVariable[] | null): VariableRow[]`

- [ ] **Step 1: Write the failing schema tests**

`tests/unit/variable-schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  variableNameSchema,
  variableValueSchema,
  setVariableSchema,
  importVariablesSchema,
  variableAad,
  MAX_VALUE_BYTES
} from '../../shared/schemas/variable'

describe('variableNameSchema', () => {
  it.each(['region', '_x', 'db-password', 'A1_b-2'])('accepts %s', (name) => {
    expect(variableNameSchema.safeParse(name).success).toBe(true)
  })
  it.each(['', '1abc', 'has space', 'dot.ted', 'a/b', 'x'.repeat(129)])('refuses %j', (name) => {
    expect(variableNameSchema.safeParse(name).success).toBe(false)
  })
})

describe('variableValueSchema', () => {
  it.each([['s'], [3], [true], [null], [['a', 1]], [{ a: { b: [1] } }]])('accepts %j', (v) => {
    expect(variableValueSchema.safeParse(v).success).toBe(true)
  })
  it('refuses a value over 64 KiB', () => {
    expect(variableValueSchema.safeParse('x'.repeat(MAX_VALUE_BYTES)).success).toBe(false)
  })
  it('accepts a value exactly at the limit once serialised', () => {
    // JSON.stringify adds two quote characters.
    expect(variableValueSchema.safeParse('x'.repeat(MAX_VALUE_BYTES - 2)).success).toBe(true)
  })
})

describe('setVariableSchema', () => {
  it('defaults sensitive to true', () => {
    expect(setVariableSchema.parse({ value: 'v' }).sensitive).toBe(true)
  })
  it('allows value to be omitted', () => {
    expect(setVariableSchema.parse({ sensitive: true }).value).toBeUndefined()
  })
})

describe('importVariablesSchema', () => {
  it('accepts a values map', () => {
    expect(importVariablesSchema.parse({ values: { a: 1 } })).toMatchObject({ dryRun: false })
  })
  it('accepts hcl source', () => {
    expect(importVariablesSchema.parse({ hcl: 'a = 1', dryRun: true }).dryRun).toBe(true)
  })
  it('refuses a bad name inside values', () => {
    expect(importVariablesSchema.safeParse({ values: { '1bad': 1 } }).success).toBe(false)
  })
  it('refuses more than 500 values', () => {
    const values = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`v${i}`, i]))
    expect(importVariablesSchema.safeParse({ values }).success).toBe(false)
  })
})

describe('variableAad', () => {
  it('binds environment and name', () => {
    expect(variableAad('e1', 'x').toString('utf8')).toBe('variable:e1:x')
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run tests/unit/variable-schemas.test.ts`
Expected: FAIL. The exports do not exist.

- [ ] **Step 3: Implement the schemas**

Append to `shared/schemas/variable.ts`:

```ts
import { projectSlug } from './project'

export const MAX_VALUE_BYTES = 65_536
export const MAX_VARIABLES_PER_ENVIRONMENT = 500

/**
 * Terraform's own identifier rule. A name Terraform cannot declare would be
 * stored, delivered, and then ignored at plan time with nothing but a warning,
 * so it is refused here instead.
 */
export const variableNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_-]*$/,
    'must start with a letter or underscore and contain only letters, digits, _ and -'
  )

/**
 * Anything `.tfvars.json` can carry. The size is measured on the serialised
 * form because that is what gets sealed and stored.
 */
export const variableValueSchema = z
  .json()
  .refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= MAX_VALUE_BYTES, {
    message: `must be at most ${MAX_VALUE_BYTES / 1024} KiB once serialised`
  })
export type JsonValue = z.infer<typeof variableValueSchema>

/**
 * `value` is optional so a sensitive variable's sensitive flag or description
 * can change without its value ever travelling to the browser and back.
 * Whether an omitted value is acceptable depends on what is stored, so that
 * rule lives in the service, not here.
 */
export const setVariableSchema = z.object({
  value: variableValueSchema.optional(),
  sensitive: z.boolean().default(true),
  description: z.string().max(1024).nullish()
})
export type SetVariableInput = z.infer<typeof setVariableSchema>

const importValuesSchema = z
  .record(variableNameSchema, variableValueSchema)
  .refine((v) => Object.keys(v).length <= MAX_VARIABLES_PER_ENVIRONMENT, {
    message: `at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables per environment`
  })

export const importVariablesSchema = z.union([
  z.object({ values: importValuesSchema, dryRun: z.boolean().default(false) }),
  z.object({ hcl: z.string().max(1_048_576), dryRun: z.boolean().default(false) })
])
export type ImportVariablesInput = z.infer<typeof importVariablesSchema>

export const createEnvironmentSchema = z.object({ slug: projectSlug })

/** The associated data every variable is sealed under (variables spec §4). */
export function variableAad(environmentId: string, name: string): Buffer {
  return Buffer.from(`variable:${environmentId}:${name}`, 'utf8')
}
```

Move the `import { projectSlug }` line to the top of the file with the other import.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm vitest run tests/unit/variable-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing merge tests**

`tests/unit/variable-status.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mergeVariables, type StoredVariable } from '../../server/utils/variable-status'
import type { DeclaredVariable } from '../../shared/schemas/variable'

const stored = (name: string, extra: Partial<StoredVariable> = {}): StoredVariable => ({
  name,
  sensitive: true,
  description: null,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u1',
  ...extra
})
const declared = (name: string, extra: Partial<DeclaredVariable> = {}): DeclaredVariable => ({
  name,
  typeExpr: 'string',
  hasDefault: false,
  sensitive: false,
  description: null,
  file: 'variables.tf',
  line: 1,
  ...extra
})

describe('mergeVariables', () => {
  it('reports no status at all without a declared set', () => {
    const rows = mergeVariables([stored('a')], null)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBeNull()
  })

  it('classifies all four statuses', () => {
    const rows = mergeVariables(
      [stored('set_one'), stored('extra')],
      [declared('set_one'), declared('need'), declared('opt', { hasDefault: true })]
    )
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.status]))
    expect(byName).toEqual({ set_one: 'set', extra: 'undeclared', need: 'missing', opt: 'optional' })
  })

  it('puts missing first, then sorts by name', () => {
    const rows = mergeVariables([stored('b'), stored('a')], [declared('z'), declared('a'), declared('b')])
    expect(rows.map((r) => r.name)).toEqual(['z', 'a', 'b'])
  })

  it('falls back to the declared description', () => {
    const rows = mergeVariables([stored('a')], [declared('a', { description: 'from repo' })])
    expect(rows[0]?.description).toBe('from repo')
  })

  it('prefers the stored description', () => {
    const rows = mergeVariables([stored('a', { description: 'mine' })], [declared('a', { description: 'repo' })])
    expect(rows[0]?.description).toBe('mine')
  })

  it('never carries a value for a sensitive row', () => {
    const rows = mergeVariables([stored('a', { sensitive: true, value: 'leak' })], null)
    expect(rows[0]).not.toHaveProperty('value')
  })

  it('carries a non-sensitive value', () => {
    const rows = mergeVariables([stored('a', { sensitive: false, value: 3 })], null)
    expect(rows[0]?.value).toBe(3)
  })
})
```

- [ ] **Step 6: Run to see them fail**

Run: `pnpm vitest run tests/unit/variable-status.test.ts`
Expected: FAIL. Module not found.

- [ ] **Step 7: Implement the merge**

`server/utils/variable-status.ts`:

```ts
import type { DeclaredVariable, JsonValue } from '../../shared/schemas/variable'

export type VariableStatus = 'missing' | 'set' | 'optional' | 'undeclared'

export type StoredVariable = {
  name: string
  sensitive: boolean
  description: string | null
  /** Present only for non-sensitive rows; the service never decrypts the rest. */
  value?: JsonValue
  updatedAt: Date
  updatedBy: string | null
}

export type VariableRow = {
  name: string
  /** Null when no repository is linked or none has synced: there is nothing to compare with. */
  status: VariableStatus | null
  stored: boolean
  sensitive: boolean
  value?: JsonValue
  description: string | null
  updatedAt: string | null
  updatedBy: string | null
  declared: DeclaredVariable | null
}

const ORDER: Record<VariableStatus, number> = { missing: 0, set: 1, optional: 1, undeclared: 1 }

/**
 * One row per name in stored ∪ declared (variables spec §8). Pure, so every
 * combination is testable without a database.
 *
 * The sensitive check is repeated here even though the service already omits
 * those values: this is the last function before a UI response, and a value
 * that reaches it by mistake must still not leave.
 */
export function mergeVariables(
  stored: StoredVariable[],
  declared: DeclaredVariable[] | null
): VariableRow[] {
  const declaredByName = new Map((declared ?? []).map((d) => [d.name, d]))
  const storedByName = new Map(stored.map((s) => [s.name, s]))
  const names = new Set([...storedByName.keys(), ...declaredByName.keys()])

  const rows = [...names].map((name): VariableRow => {
    const s = storedByName.get(name)
    const d = declaredByName.get(name) ?? null
    const status: VariableStatus | null =
      declared === null ? null : s ? (d ? 'set' : 'undeclared') : d?.hasDefault ? 'optional' : 'missing'
    const row: VariableRow = {
      name,
      status,
      stored: s !== undefined,
      sensitive: s?.sensitive ?? d?.sensitive ?? true,
      description: s?.description ?? d?.description ?? null,
      updatedAt: s ? s.updatedAt.toISOString() : null,
      updatedBy: s?.updatedBy ?? null,
      declared: d
    }
    if (s && !s.sensitive && s.value !== undefined) row.value = s.value
    return row
  })

  return rows.sort((a, b) => {
    const rank = (r: VariableRow) => (r.status ? ORDER[r.status] : 1)
    return rank(a) - rank(b) || a.name.localeCompare(b.name)
  })
}
```

- [ ] **Step 8: Run both suites to see them pass**

Run: `pnpm vitest run tests/unit/variable-schemas.test.ts tests/unit/variable-status.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add shared/schemas/variable.ts server/utils/variable-status.ts tests/unit/variable-schemas.test.ts tests/unit/variable-status.test.ts
git commit -m "feat: add variable schemas and the declared-versus-stored merge"
```

---

### Task 4: The `vars` token permission

**Files:**
- Modify: `shared/schemas/token.ts`, `server/utils/token-mapping.ts`, `server/utils/tf-auth.ts`, `server/api/ui/tokens.get.ts`
- Test: `tests/ui/tokens.test.ts`, `tests/unit/schemas.test.ts`, `tests/protocol/tf-auth.test.ts`

**Interfaces:**
- Produces: `varActionSchema = z.enum(['read'])`, `type VarAction`; `TokenConfig.varActions: VarAction[]` (default `[]`); `TokenConfig.actions` now defaults to `[]`; `TfPrincipal.varActions: VarAction[]`; `authorizeVars(principal: TfPrincipal, ref: ProjectRef): void`; `tokens.get` rows gain `varActions: VarAction[]`.

- [ ] **Step 1: Write the failing tests**

Append to the `token config mapping` describe in `tests/ui/tokens.test.ts`:

```ts
  it('omits the vars resource when no variable action is granted', () => {
    const config = tokenConfigSchema.parse({ name: 'ci', actions: ['read'], scope: { kind: 'all' } })
    expect(toApiKeyBody(config, 'u1').permissions).toEqual({ state: ['read'] })
  })

  it('maps varActions onto the vars resource', () => {
    const config = tokenConfigSchema.parse({
      name: 'ci',
      actions: ['read'],
      varActions: ['read'],
      scope: { kind: 'all' }
    })
    expect(toApiKeyBody(config, 'u1').permissions).toEqual({ state: ['read'], vars: ['read'] })
  })

  it('allows a variables-only token', () => {
    const config = tokenConfigSchema.parse({ name: 'ci', varActions: ['read'], scope: { kind: 'all' } })
    expect(toApiKeyBody(config, 'u1').permissions).toEqual({ state: [], vars: ['read'] })
  })
```

Append to `tests/unit/schemas.test.ts`:

```ts
import { tokenConfigSchema } from '../../shared/schemas/token'

describe('tokenConfigSchema permissions', () => {
  it('refuses a token that grants nothing', () => {
    const result = tokenConfigSchema.safeParse({ name: 'x', actions: [], varActions: [], scope: { kind: 'all' } })
    expect(result.success).toBe(false)
  })
  it('refuses an unknown variable action', () => {
    const result = tokenConfigSchema.safeParse({ name: 'x', varActions: ['write'], scope: { kind: 'all' } })
    expect(result.success).toBe(false)
  })
})
```

(If `tests/unit/schemas.test.ts` already imports `tokenConfigSchema`, drop the duplicate import. If it has a test asserting `actions: []` is refused, it still holds, because both lists are empty there.)

Append to `tests/protocol/tf-auth.test.ts`:

```ts
import { authorizeVars, type TfPrincipal } from '../../server/utils/tf-auth'
import '../ui/nitro-globals'

describe('authorizeVars', () => {
  const principal = (over: Partial<TfPrincipal>): TfPrincipal => ({
    userId: 'u',
    keyId: 'k',
    actions: ['read'],
    varActions: [],
    scope: { kind: 'projects', projects: ['acme/prod'] },
    ...over
  })
  const ref = { org: 'acme', project: 'prod' }

  it('refuses a state-only token with 403', () => {
    expect(() => authorizeVars(principal({}), ref)).toThrow(expect.objectContaining({ statusCode: 403 }))
  })
  it('refuses an out-of-scope token with 403', () => {
    expect(() =>
      authorizeVars(principal({ varActions: ['read'] }), { org: 'acme', project: 'staging' })
    ).toThrow(expect.objectContaining({ statusCode: 403 }))
  })
  it('allows a scoped token with vars read', () => {
    expect(() => authorizeVars(principal({ varActions: ['read'] }), ref)).not.toThrow()
  })
})
```

`nitro-globals` provides `createError`. Put its import first in the file if the file does not already have it.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run tests/ui/tokens.test.ts tests/unit/schemas.test.ts tests/protocol/tf-auth.test.ts`
Expected: FAIL. `varActions` is stripped as an unknown key and `authorizeVars` is not exported.

- [ ] **Step 3: Implement the schema**

In `shared/schemas/token.ts`:

```ts
export const varActionSchema = z.enum(['read'])
export type VarAction = z.infer<typeof varActionSchema>

export const tokenConfigSchema = z
  .object({
    name: z.string().min(1).max(64),
    // Each list may be empty on its own: a token can be for state, for
    // variables, or both. The refinement below refuses one that grants nothing.
    actions: z.array(stateActionSchema).default([]),
    varActions: z.array(varActionSchema).default([]),
    scope: tokenScopeSchema,
    expiresInDays: z.number().int().positive().max(3650).optional(),
    rateLimitMax: z.number().int().positive().optional(),
    rateLimitWindowSeconds: z.number().int().positive().optional()
  })
  .refine((c) => c.actions.length + c.varActions.length > 0, {
    message: 'Grant at least one permission',
    path: ['actions']
  })
export type TokenConfig = z.infer<typeof tokenConfigSchema>
```

- [ ] **Step 4: Implement the mapping**

In `server/utils/token-mapping.ts`, change `permissions` in `ApiKeyBody` to `{ state: string[]; vars?: string[] }` and in `toApiKeyBody`:

```ts
    // `vars` is written only when granted, so a state-only token is byte-for-
    // byte what it was before variables existed (variables spec §6).
    permissions:
      config.varActions.length > 0
        ? { state: [...config.actions], vars: [...config.varActions] }
        : { state: [...config.actions] },
```

- [ ] **Step 5: Implement the guard**

In `server/utils/tf-auth.ts`: import `varActionSchema, type VarAction`; add `varActions: VarAction[]` to `TfPrincipal`; in `authenticateTf`, after `actions`:

```ts
  // Same fail-closed parse as `actions`. Every token issued before variables
  // existed has no `vars` entry and lands here as [] — it is not widened.
  const parsedVarActions = varActionSchema.array().safeParse(result.key.permissions?.vars ?? [])
  const varActions: VarAction[] = parsedVarActions.success ? parsedVarActions.data : []
```

Return `{ userId, keyId, actions, varActions, scope }`. Then add:

```ts
/**
 * The variables door's step 3 and 4 (variables spec §5): the same project
 * scope as state, and a separate resource, so a token that can read state
 * cannot read secrets unless it was issued to.
 */
export function authorizeVars(principal: TfPrincipal, ref: ProjectRef): void {
  if (!scopeAllows(principal.scope, ref.org, ref.project)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Token is not scoped to ${ref.org}/${ref.project}`
    })
  }
  if (!principal.varActions.includes('read')) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Token does not permit reading variables'
    })
  }
}
```

- [ ] **Step 6: Surface it in the token list**

In `server/api/ui/tokens.get.ts`, add `const varActionsSchema = z.array(varActionSchema)` (import `varActionSchema`) and the row field:

```ts
    varActions: varActionsSchema.safeParse(key.permissions?.vars ?? []).data ?? [],
```

- [ ] **Step 7: Run to see them pass, then the full suite**

Run: `pnpm vitest run tests/ui/tokens.test.ts tests/unit/schemas.test.ts tests/protocol/tf-auth.test.ts && pnpm typecheck`
Expected: PASS. Typecheck points at `TokenConfigurator.vue` only if its `reactive<Partial<TokenConfig>>` broke; it should not, because the new field is optional in the input.

- [ ] **Step 8: Commit**

```bash
git add shared/schemas/token.ts server/utils/token-mapping.ts server/utils/tf-auth.ts server/api/ui/tokens.get.ts tests/ui/tokens.test.ts tests/unit/schemas.test.ts tests/protocol/tf-auth.test.ts
git commit -m "feat: add a vars permission resource to API tokens"
```

---

### Task 5: Variables service

**Files:**
- Create: `server/services/variables.ts`
- Test: `tests/integration/variables-service.test.ts`

**Interfaces:**
- Consumes: `seal`, `open` (Task 1); tables (Task 2); `variableAad`, `SetVariableInput`, `JsonValue`, `MAX_VARIABLES_PER_ENVIRONMENT` (Task 3); `StoredVariable` (Task 3).
- Produces:
  - `type EnvironmentContext = { environmentId: string; slug: string; projectId: string; orgId: string }`
  - `environmentContext(environmentId: string): Promise<EnvironmentContext>`: 404 if unknown
  - `findEnvironment(projectId: string, slug: string): Promise<{ id: string } | null>`
  - `listEnvironments(projectId: string): Promise<Array<{ id: string; slug: string }>>`: by slug
  - `createEnvironment(projectId: string, slug: string): Promise<{ id: string; slug: string }>`: 409 on duplicate
  - `deleteEnvironment(environmentId: string): Promise<void>`
  - `setVariable(args: { environmentId: string; name: string; input: SetVariableInput; userId: string }): Promise<'created' | 'updated'>`
  - `deleteVariable(environmentId: string, name: string): Promise<boolean>`
  - `readDeliveryValues(environmentId: string): Promise<Record<string, JsonValue>>`
  - `listStoredForUi(environmentId: string): Promise<StoredVariable[]>`
  - `importValues(args: { environmentId: string; values: Record<string, JsonValue>; userId: string; dryRun: boolean }): Promise<{ created: string[]; overwritten: string[] }>`

- [ ] **Step 1: Write the failing tests**

`tests/integration/variables-service.test.ts`:

```ts
import './../ui/nitro-globals'
import { describe, it, expect, beforeEach } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { variable } from '../../server/db/schema'
import { resetDb, seedProject, seedUser } from '../protocol/helpers'
import {
  createEnvironment,
  setVariable,
  deleteVariable,
  readDeliveryValues,
  listStoredForUi,
  importValues,
  listEnvironments,
  findEnvironment
} from '../../server/services/variables'

const ORG = 'vars-service'
let envId: string
let userId: string

beforeEach(async () => {
  await resetDb(ORG)
  const projectId = await seedProject(ORG, 'p')
  envId = (await createEnvironment(projectId, 'dev')).id
  userId = await seedUser('vars-service-user')
})

const set = (name: string, input: Parameters<typeof setVariable>[0]['input']) =>
  setVariable({ environmentId: envId, name, input, userId })

describe('environments', () => {
  it('refuses a duplicate slug with 409', async () => {
    const projectId = await seedProject(ORG, 'q')
    await createEnvironment(projectId, 'dev')
    await expect(createEnvironment(projectId, 'dev')).rejects.toMatchObject({ statusCode: 409 })
  })
  it('lists by slug and finds by slug', async () => {
    const projectId = await seedProject(ORG, 'r')
    await createEnvironment(projectId, 'prod')
    await createEnvironment(projectId, 'dev')
    expect((await listEnvironments(projectId)).map((e) => e.slug)).toEqual(['dev', 'prod'])
    expect(await findEnvironment(projectId, 'prod')).not.toBeNull()
    expect(await findEnvironment(projectId, 'nope')).toBeNull()
  })
})

describe('setVariable', () => {
  it('creates, then updates, and delivers the latest value', async () => {
    expect(await set('a', { value: 'one', sensitive: true })).toBe('created')
    expect(await set('a', { value: 'two', sensitive: true })).toBe('updated')
    expect(await readDeliveryValues(envId)).toEqual({ a: 'two' })
  })

  it.each(['3', 'true', 'null', '[1]', '{"a":1}'])('keeps the string %j a string', async (s) => {
    await set('s', { value: s, sensitive: false })
    expect((await readDeliveryValues(envId)).s).toBe(s)
  })

  it('round-trips structured values', async () => {
    await set('tags', { value: { team: 'core', ids: [1, 2] }, sensitive: false })
    expect((await readDeliveryValues(envId)).tags).toEqual({ team: 'core', ids: [1, 2] })
  })

  it('refuses a new variable without a value', async () => {
    await expect(set('new', { sensitive: true })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('keeps the stored value when a sensitive edit omits it', async () => {
    await set('pw', { value: 'hunter2', sensitive: true })
    await set('pw', { sensitive: true, description: 'db password' })
    expect((await readDeliveryValues(envId)).pw).toBe('hunter2')
    const [row] = await listStoredForUi(envId)
    expect(row?.description).toBe('db password')
  })

  it('refuses to make a sensitive variable non-sensitive without a new value', async () => {
    await set('pw', { value: 'hunter2', sensitive: true })
    await expect(set('pw', { sensitive: false })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('allows making it non-sensitive together with a new value', async () => {
    await set('pw', { value: 'hunter2', sensitive: true })
    await set('pw', { value: 'public', sensitive: false })
    const [row] = await listStoredForUi(envId)
    expect(row?.value).toBe('public')
  })

  it('refuses the 501st variable', async () => {
    await importValues({
      environmentId: envId,
      userId,
      dryRun: false,
      values: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`v${i}`, i]))
    })
    await expect(set('one_more', { value: 1, sensitive: false })).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('listStoredForUi', () => {
  it('omits sensitive values and includes non-sensitive ones', async () => {
    await set('secret', { value: 'hunter2', sensitive: true })
    await set('region', { value: 'eu-west-1', sensitive: false })
    const rows = await listStoredForUi(envId)
    const secret = rows.find((r) => r.name === 'secret')
    expect(secret).not.toHaveProperty('value')
    expect(rows.find((r) => r.name === 'region')?.value).toBe('eu-west-1')
  })
})

describe('sealing', () => {
  it('stores no plaintext', async () => {
    await set('pw', { value: 'plaintext-canary', sensitive: true })
    const [row] = await db().select().from(variable).where(eq(variable.environmentId, envId))
    expect(row?.valueSealed).not.toContain('plaintext-canary')
    expect(Buffer.from(row?.valueSealed ?? '', 'base64').toString('utf8')).not.toContain('plaintext-canary')
  })

  it('fails loudly when ciphertext is moved to another row', async () => {
    await set('a', { value: 'for-a', sensitive: true })
    await set('b', { value: 'for-b', sensitive: true })
    const rows = await db().select().from(variable).where(eq(variable.environmentId, envId))
    const a = rows.find((r) => r.name === 'a')
    await db()
      .update(variable)
      .set({ valueSealed: a?.valueSealed ?? '' })
      .where(and(eq(variable.environmentId, envId), eq(variable.name, 'b')))
    await expect(readDeliveryValues(envId)).rejects.toThrow()
  })
})

describe('deleteVariable', () => {
  it('reports whether a row went', async () => {
    await set('a', { value: 1, sensitive: false })
    expect(await deleteVariable(envId, 'a')).toBe(true)
    expect(await deleteVariable(envId, 'a')).toBe(false)
  })
})

describe('importValues', () => {
  it('previews without writing', async () => {
    await set('a', { value: 1, sensitive: false })
    const preview = await importValues({ environmentId: envId, userId, dryRun: true, values: { a: 2, b: 3 } })
    expect(preview).toEqual({ created: ['b'], overwritten: ['a'] })
    expect(await readDeliveryValues(envId)).toEqual({ a: 1 })
  })

  it('writes and marks every imported variable sensitive', async () => {
    await set('a', { value: 1, sensitive: false })
    await importValues({ environmentId: envId, userId, dryRun: false, values: { a: 2, b: 3 } })
    expect(await readDeliveryValues(envId)).toEqual({ a: 2, b: 3 })
    expect((await listStoredForUi(envId)).every((r) => r.sensitive)).toBe(true)
  })

  it('refuses an import that would pass 500 in total', async () => {
    await set('existing', { value: 1, sensitive: false })
    const values = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`v${i}`, i]))
    await expect(
      importValues({ environmentId: envId, userId, dryRun: false, values })
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run tests/integration/variables-service.test.ts`
Expected: FAIL. Module not found.

- [ ] **Step 3: Implement**

`server/services/variables.ts`:

```ts
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/client'
import { environment, project, variable } from '../db/schema'
import { env } from '../utils/env'
import { open, seal } from '../utils/crypto'
import {
  MAX_VARIABLES_PER_ENVIRONMENT,
  variableAad,
  type JsonValue,
  type SetVariableInput
} from '../../shared/schemas/variable'
import type { StoredVariable } from '../utils/variable-status'

export type EnvironmentContext = {
  environmentId: string
  slug: string
  projectId: string
  orgId: string
}

function sealValue(environmentId: string, name: string, value: JsonValue): string {
  const plain = Buffer.from(JSON.stringify(value), 'utf8')
  return seal(env().ENCRYPTION_KEY, plain, variableAad(environmentId, name)).toString('base64')
}

/** Throws on a wrong key, tampering, or a ciphertext moved between rows (spec §4). */
function openValue(environmentId: string, name: string, sealed: string): JsonValue {
  const plain = open(env().ENCRYPTION_KEY, Buffer.from(sealed, 'base64'), variableAad(environmentId, name))
  const parsed: JsonValue = JSON.parse(plain.toString('utf8'))
  return parsed
}

export async function environmentContext(environmentId: string): Promise<EnvironmentContext> {
  const rows = await db()
    .select({ slug: environment.slug, projectId: environment.projectId, orgId: project.orgId })
    .from(environment)
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(eq(environment.id, environmentId))
  const row = rows[0]
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Unknown environment' })
  return { environmentId, ...row }
}

export async function findEnvironment(projectId: string, slug: string): Promise<{ id: string } | null> {
  const rows = await db()
    .select({ id: environment.id })
    .from(environment)
    .where(and(eq(environment.projectId, projectId), eq(environment.slug, slug)))
  return rows[0] ?? null
}

export async function listEnvironments(projectId: string): Promise<Array<{ id: string; slug: string }>> {
  return db()
    .select({ id: environment.id, slug: environment.slug })
    .from(environment)
    .where(eq(environment.projectId, projectId))
    .orderBy(asc(environment.slug))
}

export async function createEnvironment(projectId: string, slug: string): Promise<{ id: string; slug: string }> {
  const id = ulid()
  const inserted = await db()
    .insert(environment)
    .values({ id, projectId, slug })
    .onConflictDoNothing({ target: [environment.projectId, environment.slug] })
    .returning()
  if (inserted.length === 0) {
    throw createError({ statusCode: 409, statusMessage: `Environment ${slug} already exists` })
  }
  return { id, slug }
}

export async function deleteEnvironment(environmentId: string): Promise<void> {
  await db().delete(environment).where(eq(environment.id, environmentId))
}

async function countVariables(environmentId: string): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(variable)
    .where(eq(variable.environmentId, environmentId))
  return row?.n ?? 0
}

function tooMany(): never {
  throw createError({
    statusCode: 400,
    statusMessage: `An environment holds at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables.`
  })
}

/**
 * The limit is checked before the write rather than enforced by the database,
 * so two concurrent creates can land on 501. It is a guard against runaway
 * imports, not a quota, and that race is accepted.
 */
export async function setVariable(args: {
  environmentId: string
  name: string
  input: SetVariableInput
  userId: string
}): Promise<'created' | 'updated'> {
  const { environmentId, name, input, userId } = args
  const existing = (
    await db()
      .select({ sensitive: variable.sensitive })
      .from(variable)
      .where(and(eq(variable.environmentId, environmentId), eq(variable.name, name)))
  )[0]

  if (input.value === undefined) {
    if (!existing) {
      throw createError({ statusCode: 400, statusMessage: 'A new variable needs a value.' })
    }
    // Unticking `sensitive` on its own would turn a write-only secret into one
    // the dashboard displays — a reveal by another name (variables spec §7).
    if (existing.sensitive && !input.sensitive) {
      throw createError({
        statusCode: 400,
        statusMessage: 'A sensitive variable can only be made non-sensitive together with a new value.'
      })
    }
    await db()
      .update(variable)
      .set({ sensitive: input.sensitive, description: input.description ?? null, updatedBy: userId, updatedAt: new Date() })
      .where(and(eq(variable.environmentId, environmentId), eq(variable.name, name)))
    return 'updated'
  }

  if (!existing && (await countVariables(environmentId)) >= MAX_VARIABLES_PER_ENVIRONMENT) tooMany()

  const valueSealed = sealValue(environmentId, name, input.value)
  await db()
    .insert(variable)
    .values({
      id: ulid(),
      environmentId,
      name,
      valueSealed,
      sensitive: input.sensitive,
      description: input.description ?? null,
      updatedBy: userId
    })
    .onConflictDoUpdate({
      target: [variable.environmentId, variable.name],
      set: {
        valueSealed,
        sensitive: input.sensitive,
        description: input.description ?? null,
        updatedBy: userId,
        updatedAt: new Date()
      }
    })
  return existing ? 'updated' : 'created'
}

export async function deleteVariable(environmentId: string, name: string): Promise<boolean> {
  const deleted = await db()
    .delete(variable)
    .where(and(eq(variable.environmentId, environmentId), eq(variable.name, name)))
    .returning()
  return deleted.length > 0
}

/** The only function that decrypts sensitive values. Its one caller is the token door. */
export async function readDeliveryValues(environmentId: string): Promise<Record<string, JsonValue>> {
  const rows = await db()
    .select({ name: variable.name, valueSealed: variable.valueSealed })
    .from(variable)
    .where(eq(variable.environmentId, environmentId))
    .orderBy(asc(variable.name))
  return Object.fromEntries(rows.map((r) => [r.name, openValue(environmentId, r.name, r.valueSealed)]))
}

export async function listStoredForUi(environmentId: string): Promise<StoredVariable[]> {
  const rows = await db()
    .select()
    .from(variable)
    .where(eq(variable.environmentId, environmentId))
    .orderBy(asc(variable.name))
  return rows.map((r) => {
    const base: StoredVariable = {
      name: r.name,
      sensitive: r.sensitive,
      description: r.description,
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy
    }
    return r.sensitive ? base : { ...base, value: openValue(environmentId, r.name, r.valueSealed) }
  })
}

/**
 * One multi-row upsert, so an import lands whole or not at all without a
 * transaction (Neon HTTP has none). Everything imported is sensitive: a file
 * of variables is assumed to hold secrets until someone says otherwise.
 */
export async function importValues(args: {
  environmentId: string
  values: Record<string, JsonValue>
  userId: string
  dryRun: boolean
}): Promise<{ created: string[]; overwritten: string[] }> {
  const { environmentId, values, userId, dryRun } = args
  const names = Object.keys(values).sort()
  if (names.length === 0) return { created: [], overwritten: [] }

  const existingRows = await db()
    .select({ name: variable.name })
    .from(variable)
    .where(and(eq(variable.environmentId, environmentId), inArray(variable.name, names)))
  const existing = new Set(existingRows.map((r) => r.name))
  const created = names.filter((n) => !existing.has(n))
  const overwritten = names.filter((n) => existing.has(n))

  if ((await countVariables(environmentId)) + created.length > MAX_VARIABLES_PER_ENVIRONMENT) tooMany()
  if (dryRun) return { created, overwritten }

  const now = new Date()
  await db()
    .insert(variable)
    .values(
      names.map((name) => ({
        id: ulid(),
        environmentId,
        name,
        valueSealed: sealValue(environmentId, name, values[name] ?? null),
        sensitive: true,
        updatedBy: userId,
        updatedAt: now
      }))
    )
    .onConflictDoUpdate({
      target: [variable.environmentId, variable.name],
      set: {
        valueSealed: sql`excluded.value_sealed`,
        sensitive: true,
        updatedBy: userId,
        updatedAt: now
      }
    })
  return { created, overwritten }
}
```

`values[name] ?? null` exists only to satisfy `noUncheckedIndexedAccess`. `name` comes from `Object.keys(values)`, so the fallback never runs.

- [ ] **Step 4: Run to see it pass**

Run: `pnpm vitest run tests/integration/variables-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/variables.ts tests/integration/variables-service.test.ts
git commit -m "feat: store variables sealed per environment and name"
```

---

### Task 6: Delivery route

**Files:**
- Create: `server/api/vars/[org]/[project]/[environment].get.ts`
- Modify: `shared/schemas/project.ts`
- Test: `tests/protocol/vars-delivery.test.ts`

**Interfaces:**
- Consumes: `authenticateTf`, `authorizeVars` (Task 4); `resolveProject` (existing); `findEnvironment`, `readDeliveryValues` (Task 5).
- Produces: `environmentRefSchema = projectRefSchema.extend({ environment: projectSlug })` in `shared/schemas/project.ts`.

- [ ] **Step 1: Write the failing test**

`tests/protocol/vars-delivery.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { and, eq } from 'drizzle-orm'
import { auth } from '../../server/utils/auth'
import { db } from '../../server/db/client'
import { auditLog } from '../../server/db/schema'
import { createEnvironment, setVariable } from '../../server/services/variables'
import { resetDb, seedProject, provisionUser } from './helpers'
import '../ui/nitro-globals'

await setup({ server: true })

const ORG = 'vars-delivery'
const tokens: Record<string, string> = {}
const get = (path: string, token?: string) =>
  fetch(absoluteUrl(path), {
    headers: token ? { authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` } : {}
  })

beforeAll(async () => {
  await resetDb(ORG)
  const projectId = await seedProject(ORG, 'prod')
  await seedProject(ORG, 'other')
  const user = await provisionUser(`vars-${Date.now()}@example.com`, 'correct horse battery', 'admin')
  const env = await createEnvironment(projectId, 'production')
  await setVariable({ environmentId: env.id, name: 'db_password', input: { value: 'hunter2', sensitive: true }, userId: user.id })
  await setVariable({ environmentId: env.id, name: 'replicas', input: { value: 3, sensitive: false }, userId: user.id })

  const make = async (name: string, permissions: Record<string, string[]>, projects: string[]) =>
    (
      await auth.api.createApiKey({
        body: { userId: user.id, name, permissions, metadata: { scope: { kind: 'projects', projects } } }
      })
    ).key
  tokens.vars = await make('vars', { state: [], vars: ['read'] }, [`${ORG}/prod`])
  tokens.stateOnly = await make('state', { state: ['read', 'write'] }, [`${ORG}/prod`])
  tokens.elsewhere = await make('elsewhere', { state: [], vars: ['read'] }, [`${ORG}/other`])
})

const path = `/api/vars/${ORG}/prod/production`

describe('GET /api/vars/:org/:project/:environment', () => {
  it('answers 401 without credentials', async () => {
    expect((await get(path)).status).toBe(401)
  })

  it('answers 404 for an unknown environment', async () => {
    expect((await get(`/api/vars/${ORG}/prod/staging`, tokens.vars)).status).toBe(404)
  })

  it('answers 404 for a malformed environment slug', async () => {
    expect((await get(`/api/vars/${ORG}/prod/Bad_Slug`, tokens.vars)).status).toBe(404)
  })

  it('answers 403 to a state-only token', async () => {
    expect((await get(path, tokens.stateOnly)).status).toBe(403)
  })

  it('answers 403 to a token scoped to another project', async () => {
    expect((await get(path, tokens.elsewhere)).status).toBe(403)
  })

  it('returns the tfvars.json body, uncached, and audits the read', async () => {
    const response = await get(path, tokens.vars)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ db_password: 'hunter2', replicas: 3 })
    const rows = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'variables.read')))
    expect(rows.some((r) => (r.metaJson as { environment?: string } | null)?.environment === 'production')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run tests/protocol/vars-delivery.test.ts`
Expected: FAIL. Every request is 404 because the route does not exist (the 401 test fails first).

- [ ] **Step 3: Add the param schema**

In `shared/schemas/project.ts`:

```ts
/** `/api/vars/:org/:project/:environment`. The environment slug is a project slug by rule. */
export const environmentRefSchema = projectRefSchema.extend({ environment: slug })
```

- [ ] **Step 4: Implement the route**

`server/api/vars/[org]/[project]/[environment].get.ts`:

```ts
import { authenticateTf, authorizeVars } from '../../../../utils/tf-auth'
import { resolveProject } from '../../../../utils/tf-handler'
import { findEnvironment, readDeliveryValues } from '../../../../services/variables'
import { recordAuditBestEffort } from '../../../../services/audit'
import { environmentRefSchema } from '../../../../../shared/schemas/project'

/**
 * Delivery (variables spec §5). The body is a `.tfvars.json` file, and the
 * order of checks is the state door's: credentials before anything touches the
 * database, existence before authorization.
 */
export default defineEventHandler(async (event) => {
  const principal = await authenticateTf(event)

  let params: { org: string; project: string; environment: string }
  try {
    params = await getValidatedRouterParams(event, environmentRefSchema.parse)
  } catch {
    // Same reasoning as refFromEvent: h3 turns any validator throw into 400,
    // and a slug that cannot exist is an unknown address, which is 404.
    throw createError({ statusCode: 404, statusMessage: 'Unknown environment' })
  }
  const ref = { org: params.org, project: params.project }
  const resolved = await resolveProject(ref)
  const found = await findEnvironment(resolved.id, params.environment)
  if (!found) throw createError({ statusCode: 404, statusMessage: 'Unknown environment' })
  authorizeVars(principal, ref)

  const values = await readDeliveryValues(found.id)
  setResponseHeader(event, 'cache-control', 'no-store')
  await recordAuditBestEffort({
    orgId: resolved.orgId,
    projectId: resolved.id,
    actorType: 'api-key',
    actorId: principal.keyId,
    action: 'variables.read',
    meta: { environment: params.environment, count: Object.keys(values).length }
  })
  return values
})
```

- [ ] **Step 5: Run to see it pass**

Run: `pnpm vitest run tests/protocol/vars-delivery.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add shared/schemas/project.ts "server/api/vars" tests/protocol/vars-delivery.test.ts
git commit -m "feat: deliver an environment's variables as tfvars.json"
```

---

### Task 7: Dashboard routes for environments and variables

**Files:**
- Create: `server/api/ui/projects/[id]/environments.get.ts`, `server/api/ui/projects/[id]/environments.post.ts`
- Create: `server/api/ui/environments/[id].delete.ts`
- Create: `server/api/ui/environments/[id]/variables.get.ts`
- Create: `server/api/ui/environments/[id]/variables/[name].put.ts`, `server/api/ui/environments/[id]/variables/[name].delete.ts`
- Create: `server/api/ui/environments/[id]/variables/import.post.ts`
- Modify: `tests/integration/route-roles.test.ts`
- Test: `tests/ui/variables.test.ts`

**Interfaces:**
- Consumes: Task 5 service; `mergeVariables` (Task 3); `requireSession`, `requireAdmin`; `recordAuditBestEffort`.
- Produces: `GET …/variables` returns `{ environment: { id: string; slug: string }; link: LinkSummary | null; rows: VariableRow[] }`, where `type LinkSummary = { repoFullName: string; ref: string; directory: string; lastSyncedAt: string | null; lastSyncedSha: string | null; lastSyncError: string | null }`. Declare `LinkSummary` in `server/utils/variable-status.ts`. In this task `link` is always `null`; Task 14 fills it in.
- The import route in this task handles `{ values }` only. Task 10 adds `{ hcl }`.

- [ ] **Step 1: Write the failing tests**

`tests/ui/variables.test.ts`:

```ts
import { testEvent } from './nitro-globals'
import { describe, it, expect, beforeAll } from 'vitest'
import { provisionUser, signInHeaders, setRole, resetDb, seedProject } from '../protocol/helpers'
import listEnvironments from '../../server/api/ui/projects/[id]/environments.get'
import createEnvironment from '../../server/api/ui/projects/[id]/environments.post'
import deleteEnvironment from '../../server/api/ui/environments/[id].delete'
import listVariables from '../../server/api/ui/environments/[id]/variables.get'
import putVariable from '../../server/api/ui/environments/[id]/variables/[name].put'
import deleteVariable from '../../server/api/ui/environments/[id]/variables/[name].delete'
import importVariables from '../../server/api/ui/environments/[id]/variables/import.post'

const ORG = 'ui-variables'
const PASSWORD = 'correct horse battery staple'
const CANARY = `sensitive-canary-${Date.now()}`
let admin: Record<string, string>
let member: Record<string, string>
let projectId: string
let envId: string

beforeAll(async () => {
  await resetDb(ORG)
  projectId = await seedProject(ORG, 'p')
  const a = await provisionUser(`uv-admin-${Date.now()}@example.com`, PASSWORD)
  const m = await provisionUser(`uv-member-${Date.now()}@example.com`, PASSWORD)
  await setRole(a.id, 'admin')
  await setRole(m.id, 'member')
  admin = Object.fromEntries((await signInHeaders(a.email, PASSWORD)).entries())
  member = Object.fromEntries((await signInHeaders(m.email, PASSWORD)).entries())
  const created = await createEnvironment(testEvent({ headers: admin, params: { id: projectId }, body: { slug: 'dev' } }))
  envId = created.id
  await putVariable(testEvent({ headers: admin, params: { id: envId, name: 'pw' }, body: { value: CANARY } }))
  await putVariable(testEvent({ headers: admin, params: { id: envId, name: 'region' }, body: { value: 'eu', sensitive: false } }))
})

describe('environments', () => {
  it('lists for a member', async () => {
    const rows = await listEnvironments(testEvent({ headers: member, params: { id: projectId } }))
    expect(rows.map((r) => r.slug)).toEqual(['dev'])
  })
  it('404s for an unknown project', async () => {
    await expect(
      createEnvironment(testEvent({ headers: admin, params: { id: 'nope' }, body: { slug: 'x' } }))
    ).rejects.toMatchObject({ statusCode: 404 })
  })
  it('deletes', async () => {
    const tmp = await createEnvironment(testEvent({ headers: admin, params: { id: projectId }, body: { slug: 'tmp' } }))
    await deleteEnvironment(testEvent({ headers: admin, params: { id: tmp.id } }))
    const rows = await listEnvironments(testEvent({ headers: member, params: { id: projectId } }))
    expect(rows.map((r) => r.slug)).toEqual(['dev'])
  })
})

describe('variables', () => {
  it('lists rows with no status when nothing is linked', async () => {
    const body = await listVariables(testEvent({ headers: member, params: { id: envId } }))
    expect(body.link).toBeNull()
    expect(body.rows.map((r) => [r.name, r.status])).toEqual([
      ['pw', null],
      ['region', null]
    ])
    expect(body.rows.find((r) => r.name === 'region')?.value).toBe('eu')
  })

  it('refuses a malformed name with 400', async () => {
    await expect(
      putVariable(testEvent({ headers: admin, params: { id: envId, name: '1bad' }, body: { value: 'x' } }))
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('keeps a sensitive value when an edit omits it', async () => {
    await putVariable(testEvent({ headers: admin, params: { id: envId, name: 'pw' }, body: { description: 'd' } }))
    const body = await listVariables(testEvent({ headers: member, params: { id: envId } }))
    expect(body.rows.find((r) => r.name === 'pw')?.description).toBe('d')
  })

  it('deletes, and 404s the second time', async () => {
    await putVariable(testEvent({ headers: admin, params: { id: envId, name: 'gone' }, body: { value: 1 } }))
    await deleteVariable(testEvent({ headers: admin, params: { id: envId, name: 'gone' } }))
    await expect(
      deleteVariable(testEvent({ headers: admin, params: { id: envId, name: 'gone' } }))
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('previews an import', async () => {
    const preview = await importVariables(
      testEvent({ headers: admin, params: { id: envId }, body: { values: { region: 'us', fresh: 1 }, dryRun: true } })
    )
    expect(preview).toEqual({ created: ['fresh'], overwritten: ['region'] })
  })
})

/**
 * The write-only promise (variables spec §7), checked across every UI read
 * route rather than one: a sensitive value must not appear in any of them,
 * raw or sealed.
 */
describe('sensitive values never leave through the UI', () => {
  it('appears in no UI response', async () => {
    const responses = [
      await listEnvironments(testEvent({ headers: admin, params: { id: projectId } })),
      await listVariables(testEvent({ headers: admin, params: { id: envId } })),
      await putVariable(testEvent({ headers: admin, params: { id: envId, name: 'pw' }, body: { value: CANARY } })),
      await importVariables(
        testEvent({ headers: admin, params: { id: envId }, body: { values: { pw: CANARY }, dryRun: true } })
      )
    ]
    const text = JSON.stringify(responses)
    expect(text).not.toContain(CANARY)
    expect(text).not.toContain(Buffer.from(CANARY).toString('base64'))
  })
})
```

In `tests/integration/route-roles.test.ts`, import the four write routes and add them to `ADMIN_ROUTES`:

```ts
  ['POST /api/ui/projects/:id/environments', (h) => createEnvironment(testEvent({ headers: h, params: { id: 'p1' }, body: { slug: 'x' } }))],
  ['DELETE /api/ui/environments/:id', (h) => deleteEnvironment(testEvent({ headers: h, params: { id: 'e1' } }))],
  ['PUT /api/ui/environments/:id/variables/:name', (h) => putVariable(testEvent({ headers: h, params: { id: 'e1', name: 'x' }, body: {} }))],
  ['DELETE /api/ui/environments/:id/variables/:name', (h) => deleteVariable(testEvent({ headers: h, params: { id: 'e1', name: 'x' } }))],
  ['POST /api/ui/environments/:id/variables/import', (h) => importVariables(testEvent({ headers: h, params: { id: 'e1' }, body: {} }))],
```

Add the two read routes, `GET …/environments` and `GET …/variables`, to the member-readable list that follows `ADMIN_ROUTES` in that file, in the same shape as its existing entries.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run tests/ui/variables.test.ts tests/integration/route-roles.test.ts`
Expected: FAIL. Modules not found.

- [ ] **Step 3: Implement the routes**

Every route calls its guard first, then validates params with `getValidatedRouterParams`, matching `lock.delete.ts`. Shared param schemas go at the top of each file:

```ts
const paramsSchema = z.object({ id: z.string().min(1).max(64) })
```

`server/api/ui/projects/[id]/environments.get.ts`:

```ts
import { z } from 'zod'
import { requireSession } from '../../../../utils/ui-auth'
import { listEnvironments } from '../../../../services/variables'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  return listEnvironments(id)
})
```

`server/api/ui/projects/[id]/environments.post.ts`:

```ts
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../../db/client'
import { project } from '../../../../db/schema'
import { requireAdmin } from '../../../../utils/ui-auth'
import { createEnvironment } from '../../../../services/variables'
import { recordAuditBestEffort } from '../../../../services/audit'
import { createEnvironmentSchema } from '../../../../../shared/schemas/variable'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const { slug } = await readValidatedBody(event, createEnvironmentSchema.parse)
  const [owner] = await db().select({ orgId: project.orgId }).from(project).where(eq(project.id, id))
  if (!owner) throw createError({ statusCode: 404, statusMessage: 'Unknown project' })
  const created = await createEnvironment(id, slug)
  await recordAuditBestEffort({
    orgId: owner.orgId,
    projectId: id,
    actorType: 'user',
    actorId: session.userId,
    action: 'environment.create',
    meta: { environment: slug }
  })
  return created
})
```

`server/api/ui/environments/[id].delete.ts`:

```ts
import { z } from 'zod'
import { requireAdmin } from '../../../utils/ui-auth'
import { deleteEnvironment, environmentContext } from '../../../services/variables'
import { recordAuditBestEffort } from '../../../services/audit'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const ctx = await environmentContext(id)
  await deleteEnvironment(id)
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'environment.delete',
    meta: { environment: ctx.slug }
  })
  return { ok: true }
})
```

`server/api/ui/environments/[id]/variables.get.ts`:

```ts
import { z } from 'zod'
import { requireSession } from '../../../../utils/ui-auth'
import { environmentContext, listStoredForUi } from '../../../../services/variables'
import { mergeVariables, type LinkSummary } from '../../../../utils/variable-status'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const ctx = await environmentContext(id)
  const link: LinkSummary | null = null
  return {
    environment: { id, slug: ctx.slug },
    link,
    rows: mergeVariables(await listStoredForUi(id), null)
  }
})
```

Add to `server/utils/variable-status.ts`:

```ts
export type LinkSummary = {
  repoFullName: string
  ref: string
  directory: string
  lastSyncedAt: string | null
  lastSyncedSha: string | null
  lastSyncError: string | null
}
```

`server/api/ui/environments/[id]/variables/[name].put.ts`:

```ts
import { z } from 'zod'
import { requireAdmin } from '../../../../../utils/ui-auth'
import { environmentContext, setVariable } from '../../../../../services/variables'
import { recordAuditBestEffort } from '../../../../../services/audit'
import { setVariableSchema, variableNameSchema } from '../../../../../../shared/schemas/variable'

const paramsSchema = z.object({ id: z.string().min(1).max(64), name: variableNameSchema })

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id, name } = await getValidatedRouterParams(event, paramsSchema.parse)
  const input = await readValidatedBody(event, setVariableSchema.parse)
  const ctx = await environmentContext(id)
  const outcome = await setVariable({ environmentId: id, name, input, userId: session.userId })
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'variable.set',
    // Names and flags only — never the value (variables spec §10).
    meta: { environment: ctx.slug, name, sensitive: input.sensitive, outcome, valueChanged: input.value !== undefined }
  })
  return { name, outcome }
})
```

`server/api/ui/environments/[id]/variables/[name].delete.ts`:

```ts
import { z } from 'zod'
import { requireAdmin } from '../../../../../utils/ui-auth'
import { deleteVariable, environmentContext } from '../../../../../services/variables'
import { recordAuditBestEffort } from '../../../../../services/audit'
import { variableNameSchema } from '../../../../../../shared/schemas/variable'

const paramsSchema = z.object({ id: z.string().min(1).max(64), name: variableNameSchema })

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id, name } = await getValidatedRouterParams(event, paramsSchema.parse)
  const ctx = await environmentContext(id)
  if (!(await deleteVariable(id, name))) {
    throw createError({ statusCode: 404, statusMessage: `No variable named ${name}` })
  }
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'variable.delete',
    meta: { environment: ctx.slug, name }
  })
  return { ok: true }
})
```

`server/api/ui/environments/[id]/variables/import.post.ts`:

```ts
import { z } from 'zod'
import { requireAdmin } from '../../../../../utils/ui-auth'
import { environmentContext, importValues } from '../../../../../services/variables'
import { recordAuditBestEffort } from '../../../../../services/audit'
import { importVariablesSchema } from '../../../../../../shared/schemas/variable'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const input = await readValidatedBody(event, importVariablesSchema.parse)
  const ctx = await environmentContext(id)
  if (!('values' in input)) {
    throw createError({ statusCode: 400, statusMessage: 'HCL import is not available yet.' })
  }
  const result = await importValues({ environmentId: id, values: input.values, userId: session.userId, dryRun: input.dryRun })
  if (!input.dryRun) {
    await recordAuditBestEffort({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      actorType: 'user',
      actorId: session.userId,
      action: 'variable.import',
      meta: { environment: ctx.slug, created: result.created.length, overwritten: result.overwritten.length }
    })
  }
  return result
})
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm vitest run tests/ui/variables.test.ts tests/integration/route-roles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/ui/projects server/api/ui/environments server/utils/variable-status.ts tests/ui/variables.test.ts tests/integration/route-roles.test.ts
git commit -m "feat: add dashboard routes for environments and variables"
```

---

### Task 8: Token configurator and list

**Files:**
- Modify: `app/components/TokenConfigurator.vue`, `app/pages/tokens.vue`

**Interfaces:**
- Consumes: `TokenConfig.varActions`, `tokens.get` row `varActions` (Task 4).

- [ ] **Step 1: Add the control**

In `TokenConfigurator.vue`, initial state gains `varActions: []`. Add below the "Allowed Operations" field:

```vue
    <UFormField
      label="Variables"
      name="varActions"
      description="Lets this token download the project's variables as a tfvars file. Sensitive values included."
    >
      <UCheckbox v-model="readVariables" label="Read Variables" />
    </UFormField>
```

with, in the script:

```ts
const readVariables = computed<boolean>({
  get: () => (state.varActions ?? []).includes('read'),
  set: (on) => {
    state.varActions = on ? ['read'] : []
  }
})
```

Remove `required` from the "Allowed Operations" `UFormField`: a variables-only token now leaves it empty. The schema's refinement reports "Grant at least one permission" on `actions` when both are empty.

- [ ] **Step 2: Show it in the list**

In `app/pages/tokens.vue`, wherever a row's `actions` are rendered, render `row.varActions.includes('read')` as an extra badge labelled `variables: read` in the same component and style the actions use.

- [ ] **Step 3: Verify in the browser**

Run `pnpm dev`, sign in as an admin, open **Tokens → New Token**. Check that: (a) unticking every state action and ticking Read Variables creates a token; (b) unticking everything shows "Grant at least one permission" under the operations field; (c) the list shows the `variables: read` badge. Take a screenshot of the form with the checkbox ticked and look at its right edge and bottom.

- [ ] **Step 4: Commit**

```bash
git add app/components/TokenConfigurator.vue app/pages/tokens.vue
git commit -m "feat: let tokens be issued with variable read access"
```

---

### Task 9: Variables tab

**Files:**
- Modify: `app/pages/projects/[org]/[project]/index.vue`
- Create: `app/components/VariablesPanel.vue`, `app/components/VariableEditModal.vue`, `app/components/VariableImportModal.vue`, `app/components/EnvironmentCreateModal.vue`, `app/utils/variable-value.ts`
- Test: `tests/unit/variable-value.test.ts`

**Interfaces:**
- Consumes: routes from Task 7.
- Produces: `parseEditorValue(text: string, mode: 'string' | 'json'): { ok: true; value: JsonValue } | { ok: false; error: string }` and `formatValue(value: JsonValue): string` in `app/utils/variable-value.ts`.

- [ ] **Step 1: Write the failing editor-value test**

`tests/unit/variable-value.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseEditorValue, formatValue } from '../../app/utils/variable-value'

describe('parseEditorValue', () => {
  it.each(['3', 'true', 'null', '[1]', '{"a":1}', ''])('string mode keeps %j a string', (text) => {
    expect(parseEditorValue(text, 'string')).toEqual({ ok: true, value: text })
  })
  it('json mode parses structures and scalars', () => {
    expect(parseEditorValue('{"a":[1,true]}', 'json')).toEqual({ ok: true, value: { a: [1, true] } })
    expect(parseEditorValue('3', 'json')).toEqual({ ok: true, value: 3 })
  })
  it('json mode reports invalid input', () => {
    const result = parseEditorValue('{a:1}', 'json')
    expect(result.ok).toBe(false)
  })
})

describe('formatValue', () => {
  it('shows strings bare and everything else as JSON', () => {
    expect(formatValue('eu-west-1')).toBe('eu-west-1')
    expect(formatValue(3)).toBe('3')
    expect(formatValue({ a: 1 })).toBe('{"a":1}')
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run tests/unit/variable-value.test.ts`
Expected: FAIL. Module not found.

- [ ] **Step 3: Implement**

`app/utils/variable-value.ts`:

```ts
import type { JsonValue } from '~~/shared/schemas/variable'

/**
 * String mode sends the text exactly as typed. "3" stays the string "3": a
 * Terraform `string` variable given a number would be converted anyway, but a
 * value that looks like JSON is not JSON just because it parses.
 */
export function parseEditorValue(
  text: string,
  mode: 'string' | 'json'
): { ok: true; value: JsonValue } | { ok: false; error: string } {
  if (mode === 'string') return { ok: true, value: text }
  try {
    const value: JsonValue = JSON.parse(text)
    return { ok: true, value }
  } catch {
    return { ok: false, error: 'Not valid JSON. Strings need double quotes in JSON mode.' }
  }
}

export function formatValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}
```

- [ ] **Step 4: Run to see it pass**

Run: `pnpm vitest run tests/unit/variable-value.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the components**

Use the same patterns as `ProjectCreateModal.vue`: `v-model:open`, `UModal` with `#body`/`#footer`, `UForm` with the shared Zod schema, `FetchError.statusMessage` as the form error, and focus on the first invalid field in `@error`. Wrap admin-only controls in the existing `AdminOnly` component.

`EnvironmentCreateModal.vue`: props `projectId: string`, model `open`, emits `created: [{ id: string; slug: string }]`. One `UInput` for slug, pre-filled `default`. POST `/api/ui/projects/${projectId}/environments` with schema `createEnvironmentSchema`.

`VariableEditModal.vue`: props `environmentId: string`, `existing: VariableRow | null` (null means create), model `open`, emits `saved`. Fields:
- name `UInput`, disabled when `existing`. Validated with `variableNameSchema`.
- value: `UTextarea` plus a `USwitch` labelled "JSON". Its initial mode is `json` when `existing?.value` is not a string, otherwise `string`. When `existing?.sensitive`, the textarea starts empty with placeholder "Leave empty to keep the current value", and an empty submit omits `value` from the body.
- `USwitch` "Sensitive", default `true`.
- description `UInput`.
- On submit, run `parseEditorValue`. If it returns `{ ok: false }`, show the error under the value field and do not send. Otherwise PUT `/api/ui/environments/${environmentId}/variables/${name}` with `{ value?, sensitive, description }`.

`VariableImportModal.vue`: props `environmentId`, model `open`, emits `imported`. A `UTextarea` for paste plus a file input (`accept=".tfvars,.json"`). Detect the format: input whose trimmed text starts with `{` is JSON, so send `{ values: JSON.parse(text) }`; anything else is HCL, so send `{ hcl: text }`. Step one POSTs with `dryRun: true` and shows "Will create: …" and "Will overwrite: …" lists. **Import** re-POSTs with `dryRun: false`. Server errors show `statusMessage` verbatim; that is where an HCL line number arrives after Task 10.

`VariablesPanel.vue`: props `projectId: string`.
- `useFetch` the environments. With 0: `EmptyState` titled "No environments yet" with a **New environment** button (admin only). With 1: an `h2` with its slug. With ≥ 2: a `USelect` switcher whose selection is kept in `route.query.env`.
- `useFetch` `/api/ui/environments/${envId}/variables` with `watch` on the env id.
- `UTable` columns: Name, Status (rendered only when any `row.status !== null`; badge colours: missing = error, set = success, optional = neutral, undeclared = warning), Value (`formatValue(row.value)` in a `<code>` for non-sensitive; `••••••` for sensitive; "Not set" for `!row.stored`), Description, Updated (`updatedAt` relative), and an actions column (admin only: Edit, Delete). Delete opens a small confirmation `UModal`, never `window.confirm`.
- Above the table, admin only: **Add variable**, **Import**, and a **Delete environment** button that opens a confirmation modal naming the variable count.
- A "Use in CI" disclosure (closed) with the curl recipe built from `useRequestURL().origin`:
  `curl -fsS -u "statesman:$STATESMAN_TOKEN" <origin>/api/vars/<org>/<project>/<env> -o statesman.auto.tfvars.json`

`index.vue` (project page): wrap the existing content in `UTabs` with items `State` and `Variables`. The selected tab is kept in `route.query.tab`, default `state`. The State tab renders the existing template unchanged. The Variables tab renders `<VariablesPanel :project-id="current.id" />` when `current` is non-null.

- [ ] **Step 6: Verify in the browser**

Run `pnpm dev`, then sign in as admin and open `acme/prod`. Check each state and take a screenshot of each:
1. Variables tab with no environment: the empty state and button.
2. After creating `default`: a heading rather than a switcher.
3. After creating a second environment: the switcher appears.
4. Add a sensitive variable `db_password` and a non-sensitive JSON variable `tags = {"team":"core"}`. The table shows `••••••` and `{"team":"core"}`.
5. Edit `db_password`, leave the value empty, change the description, and save. Run the CI curl with a vars token: the value is unchanged.
6. Import `{"region":"eu","db_password":"x"}`. The preview lists `region` to create and `db_password` to overwrite.
7. Sign in as a member: no add, edit, delete or import controls.
8. Press Esc in each modal: it closes.

For every screenshot, check the table's right edge (actions column not clipped) and the bottom row. Say what was checked.

- [ ] **Step 7: Commit**

```bash
git add app/utils/variable-value.ts tests/unit/variable-value.test.ts app/components/VariablesPanel.vue app/components/VariableEditModal.vue app/components/VariableImportModal.vue app/components/EnvironmentCreateModal.vue "app/pages/projects/[org]/[project]/index.vue"
git commit -m "feat: add a variables tab to the project page"
```

---

### Task 10: HCL toolkit, and HCL import

**Files:**
- Create: `server/hcl/toolkit.ts`, `server/hcl/index.ts`
- Modify: `server/api/ui/environments/[id]/variables/import.post.ts`
- Test: `tests/unit/hcl.test.ts`, `tests/unit/fixtures/hcl/*.tf`, and one addition to `tests/ui/variables.test.ts`

**Interfaces:**
- Consumes: vendored WASM (Task 0); `DeclaredVariable`, `JsonValue` (Tasks 2, 3).
- Produces:
  - `class HclError extends Error { constructor(message: string, readonly file: string, readonly line: number) }`
  - `type HclToolkit = { extractVariables(source: string, file: string): DeclaredVariable[]; parseTfvars(source: string): Record<string, JsonValue> }`
  - `createHclToolkit(readAsset: (name: 'web-tree-sitter.wasm' | 'tree-sitter-hcl.wasm') => Promise<Uint8Array>): Promise<HclToolkit>`
  - `hcl(): Promise<HclToolkit>` in `server/hcl/index.ts`, memoised, reading through `useStorage('assets:server')`.

Node names below were confirmed against grammar 1.2.0 during planning: `config_file > body > block(identifier, string_lit, block_start, body, block_end)`, `attribute(identifier, expression)`, `literal_value(string_lit | numeric_lit | bool_lit | null_lit)`, `string_lit(quoted_template_start, template_literal?, quoted_template_end)`, `template_expr(heredoc_template(heredoc_start, heredoc_identifier, template_literal, heredoc_identifier))`, `collection_value(object(object_start, object_elem{key, val}…, object_end) | tuple(tuple_start, expression…, tuple_end))`. A `${…}` inside a string appears as a `template_interpolation` child of `string_lit`.

- [ ] **Step 1: Write the fixtures**

`tests/unit/fixtures/hcl/variables.tf`:

```hcl
variable "region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region"
}

variable "db_password" {
  type      = string
  sensitive = true
  description = <<-EOT
    The database password.
    Rotated quarterly.
  EOT
}

variable "tags" {
  type = map(object({ team = string, cost = optional(number) }))
  validation {
    condition     = length(var.tags) > 0
    error_message = "At least one tag."
  }
}

variable "untyped" {}

locals {
  not_a_variable = 1
}
```

`tests/unit/fixtures/hcl/broken.tf`:

```hcl
variable "ok" {}

variable "broken" {
  type =
```

- [ ] **Step 2: Write the failing tests**

`tests/unit/hcl.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHclToolkit, HclError, type HclToolkit } from '../../server/hcl/toolkit'

let hcl: HclToolkit
const fixture = (name: string) => readFileSync(join('tests/unit/fixtures/hcl', name), 'utf8')

beforeAll(async () => {
  hcl = await createHclToolkit(async (name) => readFileSync(join('server/assets/wasm', name)))
})

describe('extractVariables', () => {
  it('finds every variable block and nothing else', () => {
    const vars = hcl.extractVariables(fixture('variables.tf'), 'variables.tf')
    expect(vars.map((v) => v.name)).toEqual(['region', 'db_password', 'tags', 'untyped'])
  })

  it('reads type, default, sensitive and description', () => {
    const [region, password, tags, untyped] = hcl.extractVariables(fixture('variables.tf'), 'variables.tf')
    expect(region).toEqual({
      name: 'region',
      typeExpr: 'string',
      hasDefault: true,
      sensitive: false,
      description: 'AWS region',
      file: 'variables.tf',
      line: 1
    })
    expect(password?.sensitive).toBe(true)
    expect(password?.description).toBe('The database password.\nRotated quarterly.')
    expect(tags?.typeExpr).toBe('map(object({ team = string, cost = optional(number) }))')
    expect(tags?.hasDefault).toBe(false)
    expect(untyped).toMatchObject({ typeExpr: null, hasDefault: false, description: null })
  })

  it('returns nothing for a file without variables', () => {
    expect(hcl.extractVariables('locals { a = 1 }\n', 'main.tf')).toEqual([])
  })

  it('throws HclError with the file and line of a syntax error', () => {
    try {
      hcl.extractVariables(fixture('broken.tf'), 'broken.tf')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(HclError)
      expect(error).toMatchObject({ file: 'broken.tf' })
      expect((error as HclError).line).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('parseTfvars', () => {
  it('converts literal values to JSON', () => {
    const source = [
      'region   = "eu-west-1"',
      'replicas = 3',
      'ratio    = 0.5',
      'enabled  = true',
      'nothing  = null',
      'zones    = ["a", "b"]',
      'tags     = { team = "core", "cost-centre" = 42 }',
      'notes    = <<EOT',
      'line one',
      'EOT'
    ].join('\n')
    expect(hcl.parseTfvars(source)).toEqual({
      region: 'eu-west-1',
      replicas: 3,
      ratio: 0.5,
      enabled: true,
      nothing: null,
      zones: ['a', 'b'],
      tags: { team: 'core', 'cost-centre': 42 },
      notes: 'line one\n'
    })
  })

  it('unescapes quoted strings', () => {
    expect(hcl.parseTfvars('a = "tab\\tquote\\"nl\\n"\n')).toEqual({ a: 'tab\tquote"nl\n' })
  })

  it.each([
    ['an interpolation', 'a = "${var.x}"\n', 1],
    ['a function call', 'a = 1\nb = file("x")\n', 2],
    ['a reference', 'a = local.y\n', 1],
    ['an operation', 'a = 1 + 1\n', 1]
  ])('refuses %s with its line', (_label, source, line) => {
    expect(() => hcl.parseTfvars(source)).toThrow(expect.objectContaining({ line }))
  })

  it('refuses a block', () => {
    expect(() => hcl.parseTfvars('variable "x" {}\n')).toThrow(HclError)
  })
})
```

- [ ] **Step 3: Run to see it fail**

Run: `pnpm vitest run tests/unit/hcl.test.ts`
Expected: FAIL. Module not found.

- [ ] **Step 4: Implement the toolkit**

`server/hcl/toolkit.ts`:

```ts
import { Language, Parser, type Node } from 'web-tree-sitter'
import type { DeclaredVariable, JsonValue } from '../../shared/schemas/variable'

export class HclError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly line: number
  ) {
    super(`${file}:${line}: ${message}`)
    this.name = 'HclError'
  }
}

export type HclToolkit = {
  extractVariables(source: string, file: string): DeclaredVariable[]
  parseTfvars(source: string): Record<string, JsonValue>
}

type AssetName = 'web-tree-sitter.wasm' | 'tree-sitter-hcl.wasm'

const lineOf = (node: Node) => node.startPosition.row + 1

function firstError(node: Node): Node | null {
  if (node.type === 'ERROR' || node.isMissing) return node
  for (const child of node.children) {
    if (child?.hasError) return firstError(child) ?? child
  }
  return null
}

function childOfType(node: Node, type: string): Node | null {
  return node.children.find((c) => c?.type === type) ?? null
}

/** `<<-` strips the smallest common indent; `<<` keeps the text as written. */
function heredocText(node: Node): string {
  const start = childOfType(node, 'heredoc_start')?.text ?? '<<'
  const body = childOfType(node, 'template_literal')?.text ?? ''
  if (!start.startsWith('<<-')) return body
  const lines = body.split('\n')
  const indents = lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length)
  const strip = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(strip)).join('\n')
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }

function unescape(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, e: string) => {
    if (e.startsWith('u') || e.startsWith('U')) return String.fromCodePoint(Number.parseInt(e.slice(1), 16))
    return ESCAPES[e] ?? e
  })
}

/**
 * Converts a LITERAL expression to JSON and refuses anything else. A tfvars
 * file may only contain literals for Terraform too; an expression that slipped
 * through here would be stored as its source text and delivered as a string,
 * which is the one outcome worse than an error.
 */
function literal(node: Node, file: string): JsonValue {
  const inner = node.type === 'expression' ? node.firstNamedChild : node
  if (!inner) throw new HclError('empty expression', file, lineOf(node))
  switch (inner.type) {
    case 'literal_value':
      return literal(inner.firstNamedChild ?? inner, file)
    case 'numeric_lit':
      return Number(inner.text)
    case 'bool_lit':
      return inner.text === 'true'
    case 'null_lit':
      return null
    case 'string_lit': {
      if (childOfType(inner, 'template_interpolation') || childOfType(inner, 'template_directive')) {
        throw new HclError('interpolation is not allowed in a variables file', file, lineOf(inner))
      }
      return unescape(childOfType(inner, 'template_literal')?.text ?? '')
    }
    case 'template_expr': {
      const heredoc = childOfType(inner, 'heredoc_template')
      if (!heredoc || childOfType(heredoc, 'template_interpolation')) {
        throw new HclError('only literal heredocs are allowed', file, lineOf(inner))
      }
      return heredocText(heredoc)
    }
    case 'collection_value': {
      const collection = inner.firstNamedChild
      if (collection?.type === 'tuple') {
        return collection.namedChildren
          .filter((c): c is Node => c?.type === 'expression')
          .map((c) => literal(c, file))
      }
      if (collection?.type === 'object') {
        const out: Record<string, JsonValue> = {}
        for (const elem of collection.namedChildren) {
          if (elem?.type !== 'object_elem') continue
          const key = elem.childForFieldName('key')
          const val = elem.childForFieldName('val')
          if (!key || !val) throw new HclError('malformed object element', file, lineOf(elem))
          const keyInner = key.firstNamedChild
          const name =
            keyInner?.type === 'variable_expr'
              ? keyInner.text
              : (() => {
                  const k = literal(key, file)
                  if (typeof k !== 'string') throw new HclError('object keys must be names or strings', file, lineOf(key))
                  return k
                })()
          out[name] = literal(val, file)
        }
        return out
      }
      throw new HclError('unsupported collection', file, lineOf(inner))
    }
    default:
      throw new HclError(`expressions are not allowed in a variables file (found ${inner.type})`, file, lineOf(inner))
  }
}

function blockLabel(block: Node): string | null {
  const label = childOfType(block, 'string_lit')
  return label ? (childOfType(label, 'template_literal')?.text ?? '') : null
}

function attributes(body: Node | null): Map<string, Node> {
  const out = new Map<string, Node>()
  for (const child of body?.namedChildren ?? []) {
    if (child?.type !== 'attribute') continue
    const name = childOfType(child, 'identifier')?.text
    const expr = childOfType(child, 'expression')
    if (name && expr) out.set(name, expr)
  }
  return out
}

export async function createHclToolkit(readAsset: (name: AssetName) => Promise<Uint8Array>): Promise<HclToolkit> {
  await Parser.init({ wasmBinary: await readAsset('web-tree-sitter.wasm') })
  const language = await Language.load(await readAsset('tree-sitter-hcl.wasm'))
  const parser = new Parser()
  parser.setLanguage(language)

  function parse(source: string, file: string): Node {
    const tree = parser.parse(source)
    if (!tree) throw new HclError('could not be parsed', file, 1)
    const error = tree.rootNode.hasError ? firstError(tree.rootNode) : null
    if (error) throw new HclError('syntax error', file, lineOf(error))
    return tree.rootNode
  }

  return {
    extractVariables(source, file) {
      const body = childOfType(parse(source, file), 'body')
      const out: DeclaredVariable[] = []
      for (const block of body?.namedChildren ?? []) {
        if (block?.type !== 'block' || childOfType(block, 'identifier')?.text !== 'variable') continue
        const name = blockLabel(block)
        if (!name) continue
        const attrs = attributes(childOfType(block, 'body'))
        const description = attrs.get('description')
        const sensitive = attrs.get('sensitive')
        out.push({
          name,
          typeExpr: attrs.get('type')?.text ?? null,
          hasDefault: attrs.has('default'),
          sensitive: sensitive ? literal(sensitive, file) === true : false,
          description: description ? String(literal(description, file)).trimEnd() : null,
          file,
          line: lineOf(block)
        })
      }
      return out
    },

    parseTfvars(source) {
      const file = 'tfvars'
      const body = childOfType(parse(source, file), 'body')
      const out: Record<string, JsonValue> = {}
      for (const child of body?.namedChildren ?? []) {
        if (!child) continue
        if (child.type !== 'attribute') {
          throw new HclError('a variables file may only contain name = value lines', file, lineOf(child))
        }
        const name = childOfType(child, 'identifier')?.text
        const expr = childOfType(child, 'expression')
        if (!name || !expr) throw new HclError('malformed assignment', file, lineOf(child))
        out[name] = literal(expr, file)
      }
      return out
    }
  }
}
```

The `trimEnd()` on description drops the trailing newline that a heredoc always carries. `web-tree-sitter` types its child arrays as `(Node | null)[]`, which is why the loops narrow with `?.`.

`server/hcl/index.ts`:

```ts
import { createHclToolkit, type HclToolkit } from './toolkit'

let toolkit: Promise<HclToolkit> | undefined

/**
 * The binaries are Nitro server assets (server/assets/wasm), which every preset
 * bundles — Vercel included, proven in Task 0 of the variables plan. Memoised:
 * instantiating the parser costs tens of milliseconds and the result is
 * stateless between parses.
 */
export function hcl(): Promise<HclToolkit> {
  toolkit ??= createHclToolkit(async (name) => {
    const bytes = await useStorage('assets:server').getItemRaw<Uint8Array>(`wasm:${name}`)
    if (!bytes) throw new Error(`parser asset missing: server/assets/wasm/${name}`)
    return bytes
  })
  return toolkit
}
```

- [ ] **Step 5: Run to see it pass**

Run: `pnpm vitest run tests/unit/hcl.test.ts`
Expected: PASS. If a node name differs from what the code expects, print `tree.rootNode.toString()` for the failing input, fix the name, and repeat.

- [ ] **Step 6: Route HCL through the import**

Add to `tests/ui/variables.test.ts` (the test imports the route, so stub `useStorage` the same way `nitro-globals` stubs other auto-imports. Add to `tests/ui/nitro-globals.ts`'s `Object.assign(globalThis, …)` a `useStorage` that reads from `server/assets/` on disk:

```ts
  useStorage: (_base: string) => ({
    getItemRaw: async (key: string) => readFileSync(join('server/assets', key.replaceAll(':', '/')))
  }),
```

with `import { readFileSync } from 'node:fs'` and `import { join } from 'node:path'` at the top):

```ts
  it('imports HCL and reports an expression with its line', async () => {
    const preview = await importVariables(
      testEvent({ headers: admin, params: { id: envId }, body: { hcl: 'zone = "a"\n', dryRun: true } })
    )
    expect(preview.created).toContain('zone')
    await expect(
      importVariables(testEvent({ headers: admin, params: { id: envId }, body: { hcl: 'a = 1\nb = var.x\n', dryRun: true } }))
    ).rejects.toMatchObject({ statusCode: 400, statusMessage: expect.stringContaining('tfvars:2') })
  })
```

In `import.post.ts`, replace the `if (!('values' in input))` block with:

```ts
  let values: Record<string, JsonValue>
  if ('values' in input) {
    values = input.values
  } else {
    try {
      values = (await hcl()).parseTfvars(input.hcl)
    } catch (error) {
      if (error instanceof HclError) throw createError({ statusCode: 400, statusMessage: error.message })
      throw error
    }
    // Names from HCL have not been through the shared schema yet.
    const checked = importVariablesSchema.safeParse({ values })
    if (!checked.success || !('values' in checked.data)) {
      throw createError({ statusCode: 400, statusMessage: checked.error?.issues[0]?.message ?? 'Invalid variables' })
    }
    values = checked.data.values
  }
```

and pass `values` to `importValues`. Import `hcl` from `../../../../../hcl`, `HclError` from `../../../../../hcl/toolkit`, and `type JsonValue`.

Run: `pnpm vitest run tests/ui/variables.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/hcl tests/unit/hcl.test.ts tests/unit/fixtures/hcl "server/api/ui/environments/[id]/variables/import.post.ts" tests/ui/variables.test.ts tests/ui/nitro-globals.ts
git commit -m "feat: parse variable blocks and literal tfvars with tree-sitter"
```

---

### Task 11: GitHub App configuration and client

**Files:**
- Modify: `server/utils/env.ts`, `.env.example`
- Create: `server/github/client.ts`, `server/github/signature.ts`
- Test: `tests/unit/env.test.ts`, `tests/unit/github-client.test.ts`, `tests/unit/github-signature.test.ts`

**Interfaces:**
- Produces:
  - `Env.GITHUB_APP: GitHubAppConfig | null`, where `type GitHubAppConfig = { id: string; slug: string; privateKey: string; webhookSecret: string }`
  - `class GitHubError extends Error { constructor(message: string, readonly status: number) }`
  - `class GitHubClient` with `constructor(app: GitHubAppConfig, fetchImpl?: typeof fetch, now?: () => number)` and methods:
    - `getInstallation(id: number): Promise<{ id: number; accountLogin: string }>`
    - `listRepositories(installationId: number): Promise<Array<{ id: number; fullName: string; defaultBranch: string }>>`
    - `resolveCommit(installationId: number, fullName: string, ref: string): Promise<string>`
    - `listTfFiles(installationId: number, fullName: string, directory: string, sha: string): Promise<string[]>` (paths)
    - `readFile(installationId: number, fullName: string, path: string, sha: string): Promise<string>`
  - `github(): GitHubClient | null` (memoised from `env().GITHUB_APP`)
  - `appJwt(appId: string, privateKey: string, nowMs: number): string`
  - `verifySignature(secret: string, rawBody: Uint8Array, header: string | undefined): boolean`

- [ ] **Step 1: Write the failing env tests**

Append to `tests/unit/env.test.ts`, following its existing `loadEnv({...base, ...})` pattern (use its existing base fixture object, called `base` below):

```ts
describe('GitHub App configuration', () => {
  const app = {
    GITHUB_APP_ID: '123',
    GITHUB_APP_SLUG: 'statesman-acme',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----',
    GITHUB_APP_WEBHOOK_SECRET: 'whsec'
  }

  it('is null when none are set', () => {
    expect(loadEnv(base).GITHUB_APP).toBeNull()
  })

  it('is loaded when all are set, with \\n unescaped in the key', () => {
    const loaded = loadEnv({ ...base, ...app }).GITHUB_APP
    expect(loaded?.privateKey).toContain('\nabc\n')
    expect(loaded?.slug).toBe('statesman-acme')
  })

  it('names the missing ones when only some are set', () => {
    expect(() => loadEnv({ ...base, GITHUB_APP_ID: '123' })).toThrow(
      /GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET/
    )
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run tests/unit/env.test.ts`
Expected: FAIL. `GITHUB_APP` is undefined.

- [ ] **Step 3: Implement the env change**

In `server/utils/env.ts`, add to the zod object:

```ts
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_SLUG: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
```

In `superRefine`:

```ts
    // All or none (variables spec §9). A partial set is almost always a
    // half-finished setup, and running with GitHub silently off would hide it.
    const github = ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET'] as const
    const missing = github.filter((k) => !v[k])
    if (missing.length > 0 && missing.length < github.length) {
      ctx.addIssue({
        code: 'custom',
        message: `GitHub App configuration is incomplete. Set all four or none; missing: ${missing.join(', ')}`
      })
    }
```

Add `GITHUB_APP: GitHubAppConfig | null` to `Env`. Export `type GitHubAppConfig = { id: string; slug: string; privateKey: string; webhookSecret: string }` from this file. In `loadEnv`'s return:

```ts
    GITHUB_APP:
      v.GITHUB_APP_ID && v.GITHUB_APP_SLUG && v.GITHUB_APP_PRIVATE_KEY && v.GITHUB_APP_WEBHOOK_SECRET
        ? {
            id: v.GITHUB_APP_ID,
            slug: v.GITHUB_APP_SLUG,
            // Hosting panels take one line; a PEM pasted there arrives with
            // literal \n sequences.
            privateKey: v.GITHUB_APP_PRIVATE_KEY.replaceAll('\\n', '\n'),
            webhookSecret: v.GITHUB_APP_WEBHOOK_SECRET
          }
        : null
```

Append to `.env.example`:

```bash
# Optional GitHub App for variable discovery (docs/github-app.md).
# Set all four, or none.
# GITHUB_APP_ID=
# GITHUB_APP_SLUG=
# GITHUB_APP_PRIVATE_KEY=
# GITHUB_APP_WEBHOOK_SECRET=
```

Run: `pnpm vitest run tests/unit/env.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing signature and client tests**

`tests/unit/github-signature.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySignature } from '../../server/github/signature'

const body = Buffer.from('{"zen":"Keep it logically awesome."}')
const sign = (secret: string, b: Uint8Array) => `sha256=${createHmac('sha256', secret).update(b).digest('hex')}`

describe('verifySignature', () => {
  it('accepts a correct signature', () => {
    expect(verifySignature('s', body, sign('s', body))).toBe(true)
  })
  it('refuses the wrong secret', () => {
    expect(verifySignature('s', body, sign('t', body))).toBe(false)
  })
  it('refuses a missing header', () => {
    expect(verifySignature('s', body, undefined)).toBe(false)
  })
  it('refuses a body changed by one byte', () => {
    const altered = Buffer.from(body)
    altered[0] = (altered[0] ?? 0) ^ 1
    expect(verifySignature('s', altered, sign('s', body))).toBe(false)
  })
  it('refuses a malformed header without throwing', () => {
    expect(verifySignature('s', body, 'sha256=zz')).toBe(false)
    expect(verifySignature('s', body, 'sha1=abc')).toBe(false)
  })
})
```

`tests/unit/github-client.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { GitHubClient, GitHubError, appJwt } from '../../server/github/client'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const app = { id: '42', slug: 's', privateKey: pem, webhookSecret: 'w' }

type Call = { method: string; url: string; auth: string | null; accept: string | null }

/** Routes `METHOD /path` to a JSON or text body; anything unrouted is a 404. */
function fakeFetch(routes: Record<string, { status?: number; json?: unknown; text?: string }>) {
  const calls: Call[] = []
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    calls.push({ method, url: url.pathname + url.search, auth: headers.get('authorization'), accept: headers.get('accept') })
    const route = routes[`${method} ${url.pathname}`]
    if (!route) return new Response('{"message":"Not Found"}', { status: 404 })
    const body = route.text ?? JSON.stringify(route.json)
    return new Response(body, { status: route.status ?? 200 })
  }
  return { impl, calls }
}

const tokenRoute = {
  'POST /app/installations/7/access_tokens': {
    status: 201,
    json: { token: 'ghs_x', expires_at: new Date(Date.now() + 3_600_000).toISOString() }
  }
}

describe('appJwt', () => {
  it('is an RS256 JWT issued by the app, backdated 60s, valid under 10 minutes', () => {
    const jwt = appJwt('42', pem, 1_000_000_000_000)
    const [h, p, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h ?? '', 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const payload = JSON.parse(Buffer.from(p ?? '', 'base64url').toString())
    expect(payload).toEqual({ iss: '42', iat: 1_000_000_000 - 60, exp: 1_000_000_000 - 60 + 540 })
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s ?? '', 'base64url'))
    expect(ok).toBe(true)
  })
})

describe('GitHubClient', () => {
  it('confirms an installation with the app JWT', async () => {
    const { impl, calls } = fakeFetch({ 'GET /app/installations/7': { json: { id: 7, account: { login: 'acme' } } } })
    const client = new GitHubClient(app, impl)
    expect(await client.getInstallation(7)).toEqual({ id: 7, accountLogin: 'acme' })
    expect(calls[0]?.auth).toMatch(/^Bearer ey/)
  })

  it('caches the installation token across calls', async () => {
    const { impl, calls } = fakeFetch({
      ...tokenRoute,
      'GET /installation/repositories': {
        json: { total_count: 1, repositories: [{ id: 1, full_name: 'acme/infra', default_branch: 'main' }] }
      }
    })
    const client = new GitHubClient(app, impl)
    await client.listRepositories(7)
    const repos = await client.listRepositories(7)
    expect(repos).toEqual([{ id: 1, fullName: 'acme/infra', defaultBranch: 'main' }])
    expect(calls.filter((c) => c.url.includes('access_tokens'))).toHaveLength(1)
    expect(calls.at(-1)?.auth).toBe('token ghs_x')
  })

  it('lists only .tf files directly in the directory', async () => {
    const { impl } = fakeFetch({
      ...tokenRoute,
      'GET /repos/acme/infra/contents/envs/prod': {
        json: [
          { type: 'file', name: 'main.tf', path: 'envs/prod/main.tf' },
          { type: 'file', name: 'prod.tfvars', path: 'envs/prod/prod.tfvars' },
          { type: 'dir', name: 'modules', path: 'envs/prod/modules' },
          { type: 'file', name: 'variables.tf', path: 'envs/prod/variables.tf' }
        ]
      }
    })
    const client = new GitHubClient(app, impl)
    expect(await client.listTfFiles(7, 'acme/infra', 'envs/prod', 'abc')).toEqual([
      'envs/prod/main.tf',
      'envs/prod/variables.tf'
    ])
  })

  it('treats the repository root as the empty directory', async () => {
    const { impl, calls } = fakeFetch({ ...tokenRoute, 'GET /repos/acme/infra/contents/': { json: [] } })
    await new GitHubClient(app, impl).listTfFiles(7, 'acme/infra', '', 'abc')
    expect(calls.at(-1)?.url).toBe('/repos/acme/infra/contents/?ref=abc')
  })

  it('reports a path that is a file, not a directory', async () => {
    const { impl } = fakeFetch({ ...tokenRoute, 'GET /repos/acme/infra/contents/main.tf': { json: { type: 'file' } } })
    await expect(new GitHubClient(app, impl).listTfFiles(7, 'acme/infra', 'main.tf', 'abc')).rejects.toThrow(
      /is a file, not a directory/
    )
  })

  it('reads raw file content', async () => {
    const { impl, calls } = fakeFetch({ ...tokenRoute, 'GET /repos/acme/infra/contents/main.tf': { text: 'variable "a" {}' } })
    expect(await new GitHubClient(app, impl).readFile(7, 'acme/infra', 'main.tf', 'abc')).toBe('variable "a" {}')
    expect(calls.at(-1)?.accept).toBe('application/vnd.github.raw')
  })

  it('resolves a branch to a commit sha', async () => {
    const { impl } = fakeFetch({ ...tokenRoute, 'GET /repos/acme/infra/commits/main': { text: 'deadbeef' } })
    expect(await new GitHubClient(app, impl).resolveCommit(7, 'acme/infra', 'main')).toBe('deadbeef')
  })

  it('raises GitHubError with GitHub’s message and status', async () => {
    const { impl } = fakeFetch(tokenRoute)
    const error = await new GitHubClient(app, impl).resolveCommit(7, 'acme/infra', 'nope').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitHubError)
    expect(error).toMatchObject({ status: 404, message: expect.stringContaining('Not Found') })
  })
})
```

- [ ] **Step 5: Run to see them fail**

Run: `pnpm vitest run tests/unit/github-signature.test.ts tests/unit/github-client.test.ts`
Expected: FAIL. Modules not found.

- [ ] **Step 6: Implement**

`server/github/signature.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * GitHub signs the exact bytes it sent. This must run on the raw body before
 * anything parses it: re-serialised JSON is not the same bytes.
 */
export function verifySignature(secret: string, rawBody: Uint8Array, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false
  const given = Buffer.from(header.slice(7), 'hex')
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  // A non-hex header decodes short; timingSafeEqual throws on unequal lengths.
  return given.length === expected.length && timingSafeEqual(given, expected)
}
```

`server/github/client.ts`:

```ts
import { createSign } from 'node:crypto'
import { env, type GitHubAppConfig } from '../utils/env'

const API = 'https://api.github.com'

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/** Backdated a minute for clock skew; GitHub caps the lifetime at ten. */
export function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const iat = Math.floor(nowMs / 1000) - 60
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat, exp: iat + 540, iss: appId })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')
  return `${unsigned}.${signature}`
}

type Repo = { id: number; full_name: string; default_branch: string }
type Entry = { type: string; name: string; path: string }

/**
 * Just the six calls statesman makes, over an injectable fetch so tests need
 * no HTTP mocking library (variables spec §9). Installation tokens live in
 * memory only and are refreshed five minutes before they expire.
 */
export class GitHubClient {
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>()

  constructor(
    private readonly app: GitHubAppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  private async call(path: string, auth: string, init: { method?: string; accept?: string } = {}): Promise<Response> {
    const response = await this.fetchImpl(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: auth,
        accept: init.accept ?? 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'statesman'
      }
    })
    if (!response.ok) {
      const text = await response.text()
      let message = text
      try {
        const parsed: { message?: unknown } = JSON.parse(text)
        if (typeof parsed.message === 'string') message = parsed.message
      } catch {
        // Not JSON; keep the text.
      }
      throw new GitHubError(`GitHub ${response.status}: ${message}`, response.status)
    }
    return response
  }

  private asApp(path: string, method?: string) {
    return this.call(path, `Bearer ${appJwt(this.app.id, this.app.privateKey, this.now())}`, { method })
  }

  private async installationAuth(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId)
    if (cached && cached.expiresAt - 300_000 > this.now()) return `token ${cached.token}`
    const response = await this.asApp(`/app/installations/${installationId}/access_tokens`, 'POST')
    const body: { token: string; expires_at: string } = await response.json()
    this.tokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) })
    return `token ${body.token}`
  }

  private async asInstallation(installationId: number, path: string, accept?: string) {
    return this.call(path, await this.installationAuth(installationId), { accept })
  }

  async getInstallation(id: number): Promise<{ id: number; accountLogin: string }> {
    const body: { id: number; account: { login: string } } = await (await this.asApp(`/app/installations/${id}`)).json()
    return { id: body.id, accountLogin: body.account.login }
  }

  async listRepositories(installationId: number): Promise<Array<{ id: number; fullName: string; defaultBranch: string }>> {
    const out: Array<{ id: number; fullName: string; defaultBranch: string }> = []
    for (let page = 1; ; page++) {
      const response = await this.asInstallation(installationId, `/installation/repositories?per_page=100&page=${page}`)
      const body: { total_count: number; repositories: Repo[] } = await response.json()
      out.push(...body.repositories.map((r) => ({ id: r.id, fullName: r.full_name, defaultBranch: r.default_branch })))
      if (out.length >= body.total_count || body.repositories.length === 0) return out
    }
  }

  async resolveCommit(installationId: number, fullName: string, ref: string): Promise<string> {
    const response = await this.asInstallation(
      installationId,
      `/repos/${fullName}/commits/${encodeURIComponent(ref)}`,
      'application/vnd.github.sha'
    )
    return (await response.text()).trim()
  }

  /** `.tf` files directly in `directory` at `sha`. Subdirectories are child modules and are not inputs. */
  async listTfFiles(installationId: number, fullName: string, directory: string, sha: string): Promise<string[]> {
    const path = directory.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    const response = await this.asInstallation(installationId, `/repos/${fullName}/contents/${path}?ref=${sha}`)
    const body: Entry[] | Entry = await response.json()
    if (!Array.isArray(body)) throw new GitHubError(`${directory || '/'} is a file, not a directory`, 400)
    return body.filter((e) => e.type === 'file' && e.name.endsWith('.tf')).map((e) => e.path)
  }

  async readFile(installationId: number, fullName: string, path: string, sha: string): Promise<string> {
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const response = await this.asInstallation(
      installationId,
      `/repos/${fullName}/contents/${encoded}?ref=${sha}`,
      'application/vnd.github.raw'
    )
    return response.text()
  }
}

let client: GitHubClient | null | undefined

export function github(): GitHubClient | null {
  if (client === undefined) {
    const config = env().GITHUB_APP
    client = config ? new GitHubClient(config) : null
  }
  return client
}
```

The fake fetch matches on `url.pathname`, so the query strings above do not affect routing. The root-directory test asserts the query on the recorded call.

- [ ] **Step 7: Run to see them pass**

Run: `pnpm vitest run tests/unit/github-signature.test.ts tests/unit/github-client.test.ts tests/unit/env.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/utils/env.ts .env.example server/github tests/unit/env.test.ts tests/unit/github-client.test.ts tests/unit/github-signature.test.ts
git commit -m "feat: add an optional GitHub App client and webhook signature check"
```

---

### Task 12: Link and unlink

**Files:**
- Create: `server/services/sync.ts`
- Test: `tests/integration/sync.test.ts`

**Interfaces:**
- Consumes: tables (Task 2), `GitHubClient` (Task 11).
- Produces:
  - `recordInstallation(installationId: number, accountLogin: string): Promise<void>` (idempotent)
  - `removeInstallation(installationId: number): Promise<void>`
  - `listInstallations(): Promise<Array<{ installationId: number; accountLogin: string }>>`
  - `linkRepository(args: { environmentId: string; installationId: number; repoId: number; repoFullName: string; ref: string; directory: string }): Promise<void>`: upsert
  - `unlinkRepository(environmentId: string): Promise<boolean>`
  - `linkSummary(environmentId: string): Promise<{ summary: LinkSummary; declared: DeclaredVariable[] | null } | null>`
  - `normaliseDirectory(input: string): string`: trims slashes, refuses `..`

- [ ] **Step 1: Write the failing tests**

`tests/integration/sync.test.ts`:

```ts
import '../ui/nitro-globals'
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { githubInstallation } from '../../server/db/schema'
import { resetDb, seedProject } from '../protocol/helpers'
import { createEnvironment } from '../../server/services/variables'
import {
  recordInstallation,
  removeInstallation,
  linkRepository,
  unlinkRepository,
  linkSummary,
  normaliseDirectory
} from '../../server/services/sync'

const ORG = 'sync-service'
// Installation ids are global, so each suite picks its own range.
const INSTALLATION = 9_100_001
let envId: string

beforeEach(async () => {
  await resetDb(ORG)
  await db().delete(githubInstallation).where(eq(githubInstallation.installationId, INSTALLATION))
  const projectId = await seedProject(ORG, 'p')
  envId = (await createEnvironment(projectId, 'dev')).id
  await recordInstallation(INSTALLATION, 'acme')
})

const link = (over: Partial<Parameters<typeof linkRepository>[0]> = {}) =>
  linkRepository({
    environmentId: envId,
    installationId: INSTALLATION,
    repoId: 55,
    repoFullName: 'acme/infra',
    ref: 'main',
    directory: 'envs/dev',
    ...over
  })

describe('normaliseDirectory', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['/envs/dev/', 'envs/dev'],
    ['envs//dev', 'envs/dev']
  ])('%j -> %j', (input, output) => {
    expect(normaliseDirectory(input)).toBe(output)
  })
  it('refuses parent segments', () => {
    expect(() => normaliseDirectory('envs/../secrets')).toThrow(expect.objectContaining({ statusCode: 400 }))
  })
})

describe('links', () => {
  it('records an installation idempotently', async () => {
    await recordInstallation(INSTALLATION, 'acme')
    const rows = await db().select().from(githubInstallation).where(eq(githubInstallation.installationId, INSTALLATION))
    expect(rows).toHaveLength(1)
  })

  it('links, relinks, and summarises without a sync', async () => {
    await link()
    await link({ ref: 'release' })
    const found = await linkSummary(envId)
    expect(found?.summary).toMatchObject({ repoFullName: 'acme/infra', ref: 'release', lastSyncedAt: null })
    expect(found?.declared).toBeNull()
  })

  it('unlinks', async () => {
    await link()
    expect(await unlinkRepository(envId)).toBe(true)
    expect(await linkSummary(envId)).toBeNull()
  })

  it('drops links when the installation is removed', async () => {
    await link()
    await removeInstallation(INSTALLATION)
    expect(await linkSummary(envId)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run tests/integration/sync.test.ts`
Expected: FAIL. Module not found.

- [ ] **Step 3: Implement**

`server/services/sync.ts`:

```ts
import { asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { githubInstallation, repositoryLink } from '../db/schema'
import type { DeclaredVariable } from '../../shared/schemas/variable'
import type { LinkSummary } from '../utils/variable-status'

export function normaliseDirectory(input: string): string {
  const parts = input.split('/').filter(Boolean)
  if (parts.some((p) => p === '..' || p === '.')) {
    throw createError({ statusCode: 400, statusMessage: 'The directory may not contain . or .. segments.' })
  }
  return parts.join('/')
}

export async function recordInstallation(installationId: number, accountLogin: string): Promise<void> {
  await db()
    .insert(githubInstallation)
    .values({ installationId, accountLogin })
    .onConflictDoUpdate({ target: githubInstallation.installationId, set: { accountLogin } })
}

export async function removeInstallation(installationId: number): Promise<void> {
  await db().delete(githubInstallation).where(eq(githubInstallation.installationId, installationId))
}

export async function listInstallations(): Promise<Array<{ installationId: number; accountLogin: string }>> {
  return db()
    .select({ installationId: githubInstallation.installationId, accountLogin: githubInstallation.accountLogin })
    .from(githubInstallation)
    .orderBy(asc(githubInstallation.accountLogin))
}

/** Relinking resets the sync state: a declared set from another repo or branch means nothing here. */
export async function linkRepository(args: {
  environmentId: string
  installationId: number
  repoId: number
  repoFullName: string
  ref: string
  directory: string
}): Promise<void> {
  const values = { ...args, directory: normaliseDirectory(args.directory) }
  const reset = { lastSyncedAt: null, lastSyncedSha: null, lastSyncError: null, declared: null }
  await db()
    .insert(repositoryLink)
    .values({ ...values, ...reset })
    .onConflictDoUpdate({ target: repositoryLink.environmentId, set: { ...values, ...reset } })
}

export async function unlinkRepository(environmentId: string): Promise<boolean> {
  const deleted = await db().delete(repositoryLink).where(eq(repositoryLink.environmentId, environmentId)).returning()
  return deleted.length > 0
}

export async function linkSummary(
  environmentId: string
): Promise<{ summary: LinkSummary; declared: DeclaredVariable[] | null } | null> {
  const [row] = await db().select().from(repositoryLink).where(eq(repositoryLink.environmentId, environmentId))
  if (!row) return null
  return {
    summary: {
      repoFullName: row.repoFullName,
      ref: row.ref,
      directory: row.directory,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastSyncedSha: row.lastSyncedSha,
      lastSyncError: row.lastSyncError
    },
    declared: row.declared
  }
}
```

- [ ] **Step 4: Run to see it pass**

Run: `pnpm vitest run tests/integration/sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/sync.ts tests/integration/sync.test.ts
git commit -m "feat: record GitHub installations and repository links"
```

---

### Task 13: Sync

**Files:**
- Modify: `server/services/sync.ts`
- Test: `tests/integration/sync.test.ts`

**Interfaces:**
- Consumes: `GitHubClient` (Task 11), `HclToolkit` (Task 10).
- Produces:
  - `type SyncDeps = { client: GitHubClient; hcl: HclToolkit }`
  - `syncEnvironment(environmentId: string, deps: SyncDeps): Promise<{ ok: true; count: number; sha: string } | { ok: false; error: string }>`. It never throws for GitHub or parse failures; it records them.
  - `linksForPush(repoId: number, ref: string): Promise<string[]>` (environment ids)
  - `markRepositoriesRevoked(installationId: number, repoIds: number[]): Promise<void>`
  - `renameRepository(repoId: number, fullName: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/sync.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { GitHubClient } from '../../server/github/client'
import { createHclToolkit, type HclToolkit } from '../../server/hcl/toolkit'
import { syncEnvironment, linksForPush, markRepositoriesRevoked } from '../../server/services/sync'

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
let hcl: HclToolkit

beforeAll(async () => {
  hcl = await createHclToolkit(async (name) => readFileSync(join('server/assets/wasm', name)))
})

/** A fake GitHub holding one repo whose files can be swapped between syncs. */
function fakeGitHub(files: Record<string, string> | 'gone') {
  const impl: typeof fetch = async (input) => {
    const url = new URL(String(input))
    const p = url.pathname
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (p.endsWith('/access_tokens')) return json({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201)
    if (p === '/repos/acme/infra/commits/main') return new Response('sha-1')
    if (p === '/repos/acme/infra/contents/envs/dev') {
      if (files === 'gone') return json({ message: 'Not Found' }, 404)
      return json(Object.keys(files).map((name) => ({ type: 'file', name, path: `envs/dev/${name}` })))
    }
    const name = p.replace('/repos/acme/infra/contents/envs/dev/', '')
    if (files !== 'gone' && name in files) return new Response(files[name])
    return json({ message: 'Not Found' }, 404)
  }
  return new GitHubClient({ id: '1', slug: 's', privateKey: pem, webhookSecret: 'w' }, impl)
}

describe('syncEnvironment', () => {
  it('stores the declared set and the sha', async () => {
    await link()
    const result = await syncEnvironment(envId, {
      client: fakeGitHub({ 'variables.tf': 'variable "a" {}\nvariable "b" { default = 1 }\n', 'readme.md': '' }),
      hcl
    })
    expect(result).toEqual({ ok: true, count: 2, sha: 'sha-1' })
    const found = await linkSummary(envId)
    expect(found?.declared?.map((d) => d.name)).toEqual(['a', 'b'])
    expect(found?.summary).toMatchObject({ lastSyncedSha: 'sha-1', lastSyncError: null })
  })

  it('keeps the previous declared set when the directory is gone', async () => {
    await link()
    await syncEnvironment(envId, { client: fakeGitHub({ 'variables.tf': 'variable "a" {}\n' }), hcl })
    const result = await syncEnvironment(envId, { client: fakeGitHub('gone'), hcl })
    expect(result.ok).toBe(false)
    const found = await linkSummary(envId)
    expect(found?.declared?.map((d) => d.name)).toEqual(['a'])
    expect(found?.summary.lastSyncError).toMatch(/Not Found/)
  })

  it('records an error for a directory with no .tf files, keeping the previous set', async () => {
    await link()
    await syncEnvironment(envId, { client: fakeGitHub({ 'variables.tf': 'variable "a" {}\n' }), hcl })
    const result = await syncEnvironment(envId, { client: fakeGitHub({ 'README.md': '' }), hcl })
    expect(result).toEqual({ ok: false, error: expect.stringContaining('No .tf files in envs/dev') })
    expect((await linkSummary(envId))?.declared?.map((d) => d.name)).toEqual(['a'])
  })

  it('fails the whole sync on one unparsable file', async () => {
    await link()
    const result = await syncEnvironment(envId, {
      client: fakeGitHub({ 'good.tf': 'variable "a" {}\n', 'bad.tf': 'variable "b" {\n  type =\n' }),
      hcl
    })
    expect(result).toEqual({ ok: false, error: expect.stringContaining('envs/dev/bad.tf') })
    expect((await linkSummary(envId))?.declared).toBeNull()
  })

  it('refuses an environment with no link', async () => {
    const result = await syncEnvironment(envId, { client: fakeGitHub({}), hcl })
    expect(result).toEqual({ ok: false, error: 'This environment is not linked to a repository.' })
  })
})

describe('push routing', () => {
  it('finds links by repo id and branch', async () => {
    await link()
    expect(await linksForPush(55, 'main')).toContain(envId)
    expect(await linksForPush(55, 'other')).not.toContain(envId)
  })

  it('marks revoked repositories', async () => {
    await link()
    await markRepositoriesRevoked(INSTALLATION, [55])
    expect((await linkSummary(envId))?.summary.lastSyncError).toMatch(/no longer has access/)
  })
})
```

Add `beforeAll` to the vitest import at the top of the file.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run tests/integration/sync.test.ts`
Expected: FAIL. `syncEnvironment` is not exported.

- [ ] **Step 3: Implement**

Append to `server/services/sync.ts` (and extend its imports with `and, inArray`, `GitHubClient`, `GitHubError`, `HclToolkit`, `HclError`):

```ts
export type SyncDeps = { client: GitHubClient; hcl: HclToolkit }
export type SyncResult = { ok: true; count: number; sha: string } | { ok: false; error: string }

/**
 * Reads the linked directory at one commit and replaces the declared set
 * (variables spec §9). Failures are RECORDED, not thrown: the caller is a
 * webhook or a button, and either way the answer belongs on the link row where
 * the dashboard shows it. A failure leaves the previous declared set alone,
 * so a bad push cannot mark every variable Undeclared.
 */
export async function syncEnvironment(environmentId: string, deps: SyncDeps): Promise<SyncResult> {
  const [link] = await db().select().from(repositoryLink).where(eq(repositoryLink.environmentId, environmentId))
  if (!link) return { ok: false, error: 'This environment is not linked to a repository.' }

  try {
    // Every read is pinned to one sha, so a push landing mid-sync cannot mix
    // two commits' files into one declared set.
    const sha = await deps.client.resolveCommit(link.installationId, link.repoFullName, link.ref)
    const paths = await deps.client.listTfFiles(link.installationId, link.repoFullName, link.directory, sha)
    if (paths.length === 0) {
      throw new GitHubError(`No .tf files in ${link.directory || 'the repository root'} at ${link.ref}.`, 404)
    }
    const declared: DeclaredVariable[] = []
    for (const path of paths) {
      const source = await deps.client.readFile(link.installationId, link.repoFullName, path, sha)
      declared.push(...deps.hcl.extractVariables(source, path))
    }
    await db()
      .update(repositoryLink)
      .set({ declared, lastSyncedAt: new Date(), lastSyncedSha: sha, lastSyncError: null })
      .where(eq(repositoryLink.environmentId, environmentId))
    return { ok: true, count: declared.length, sha }
  } catch (error) {
    if (!(error instanceof GitHubError) && !(error instanceof HclError)) throw error
    const message = error.message
    await db()
      .update(repositoryLink)
      .set({ lastSyncError: message })
      .where(eq(repositoryLink.environmentId, environmentId))
    return { ok: false, error: message }
  }
}

export async function linksForPush(repoId: number, ref: string): Promise<string[]> {
  const rows = await db()
    .select({ environmentId: repositoryLink.environmentId })
    .from(repositoryLink)
    .where(and(eq(repositoryLink.repoId, repoId), eq(repositoryLink.ref, ref)))
  return rows.map((r) => r.environmentId)
}

/** Not deleted: an admin may grant the repository back, and the link should resume. */
export async function markRepositoriesRevoked(installationId: number, repoIds: number[]): Promise<void> {
  if (repoIds.length === 0) return
  await db()
    .update(repositoryLink)
    .set({ lastSyncError: 'The GitHub App no longer has access to this repository.' })
    .where(and(eq(repositoryLink.installationId, installationId), inArray(repositoryLink.repoId, repoIds)))
}

export async function renameRepository(repoId: number, fullName: string): Promise<void> {
  await db().update(repositoryLink).set({ repoFullName: fullName }).where(eq(repositoryLink.repoId, repoId))
}
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm vitest run tests/integration/sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/sync.ts tests/integration/sync.test.ts
git commit -m "feat: sync declared variables from a linked repository"
```

---

### Task 14: Install, link and sync routes; status in the variables route

**Files:**
- Create: `server/api/github/install.get.ts`, `server/api/github/setup.get.ts`
- Create: `server/api/ui/github.get.ts`, `server/api/ui/github/installations/[id]/repositories.get.ts`
- Create: `server/api/ui/environments/[id]/link.put.ts`, `server/api/ui/environments/[id]/link.delete.ts`, `server/api/ui/environments/[id]/sync.post.ts`
- Create: `server/utils/github-guard.ts`, `server/utils/deployment-org.ts`
- Modify: `server/api/ui/environments/[id]/variables.get.ts`
- Modify: `tests/integration/route-roles.test.ts`, `tests/ui/variables.test.ts`

**Interfaces:**
- Consumes: Tasks 10–13.
- Produces:
  - `requireGitHub(): GitHubClient`: 404 `GitHub is not configured on this deployment.` when `github()` is null.
  - `deploymentOrgId(): Promise<string>`: the single organization's id, via `chooseOrganization(undefined, rows)`.
  - `GET /api/ui/github` (session): `{ configured: boolean; installUrl: string | null; installations: Array<{ installationId: number; accountLogin: string }> }`. `installUrl` is `/api/github/install` when configured.
  - `PUT …/link` body `linkInputSchema = { installationId: number; repoId: number; ref?: string; directory: string }`. Responds with the `SyncResult` of the immediate sync.

`setup.get.ts` stores and checks the CSRF `state` in a short-lived cookie rather than "in the session". Better Auth sessions carry no custom data, and an `httpOnly`, `SameSite=Lax` cookie scoped to `/api/github` gives the same guarantee. Spec §9 "Installing" already says so.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/route-roles.test.ts`, add to `ADMIN_ROUTES`:

```ts
  ['GET /api/github/install', (h) => githubInstall(testEvent({ headers: h }))],
  ['GET /api/ui/github/installations/:id/repositories', (h) => listRepos(testEvent({ headers: h, params: { id: '1' } }))],
  ['PUT /api/ui/environments/:id/link', (h) => putLink(testEvent({ headers: h, params: { id: 'e1' }, body: {} }))],
  ['DELETE /api/ui/environments/:id/link', (h) => deleteLink(testEvent({ headers: h, params: { id: 'e1' } }))],
  ['POST /api/ui/environments/:id/sync', (h) => syncNow(testEvent({ headers: h, params: { id: 'e1' } }))],
```

and `GET /api/ui/github` to the member-readable list. The test environment has no `GITHUB_APP_*`, so an admin's calls answer 404, which the "not 403" assertion accepts.

Append to `tests/ui/variables.test.ts`:

```ts
import githubStatus from '../../server/api/ui/github.get'
import { recordInstallation, linkRepository } from '../../server/services/sync'
import { db } from '../../server/db/client'
import { repositoryLink } from '../../server/db/schema'
import { eq } from 'drizzle-orm'

describe('github status and declared variables', () => {
  it('reports GitHub as not configured', async () => {
    expect(await githubStatus(testEvent({ headers: member }))).toEqual({
      configured: false,
      installUrl: null,
      installations: []
    })
  })

  it('merges a synced declared set into the variables rows', async () => {
    await recordInstallation(9_200_001, 'acme')
    await linkRepository({ environmentId: envId, installationId: 9_200_001, repoId: 77, repoFullName: 'acme/infra', ref: 'main', directory: '' })
    await db()
      .update(repositoryLink)
      .set({
        declared: [{ name: 'needed', typeExpr: 'string', hasDefault: false, sensitive: false, description: null, file: 'v.tf', line: 1 }],
        lastSyncedSha: 'abc'
      })
      .where(eq(repositoryLink.environmentId, envId))
    const body = await listVariables(testEvent({ headers: member, params: { id: envId } }))
    expect(body.link).toMatchObject({ repoFullName: 'acme/infra', lastSyncedSha: 'abc' })
    expect(body.rows[0]).toMatchObject({ name: 'needed', status: 'missing' })
  })
})
```

Note: `githubStatus` returning `installations: []` assumes no other suite has left rows behind. Filter the installations in the assertion if the shared database makes that flaky: assert `configured` and `installUrl` only.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run tests/integration/route-roles.test.ts tests/ui/variables.test.ts`
Expected: FAIL. Modules not found.

- [ ] **Step 3: Implement the helpers**

`server/utils/github-guard.ts`:

```ts
import { github, type GitHubClient } from '../github/client'

/** Every GitHub route 404s on a deployment without the app, after its auth guard. */
export function requireGitHub(): GitHubClient {
  const client = github()
  if (!client) throw createError({ statusCode: 404, statusMessage: 'GitHub is not configured on this deployment.' })
  return client
}
```

`server/utils/deployment-org.ts`:

```ts
import { db } from '../db/client'
import { organization } from '../db/schema'
import { chooseOrganization } from './organization'

/** GitHub installations belong to the deployment, which has one organization (base §5). */
export async function deploymentOrgId(): Promise<string> {
  const rows = await db().select({ id: organization.id, slug: organization.slug }).from(organization)
  return chooseOrganization(undefined, rows).id
}
```

- [ ] **Step 4: Implement the routes**

`server/api/ui/github.get.ts`:

```ts
import { requireSession } from '../../utils/ui-auth'
import { github } from '../../github/client'
import { listInstallations } from '../../services/sync'

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const configured = github() !== null
  return {
    configured,
    installUrl: configured ? '/api/github/install' : null,
    installations: configured ? await listInstallations() : []
  }
})
```

`server/api/github/install.get.ts`:

```ts
import { randomBytes } from 'node:crypto'
import { requireAdmin } from '../../utils/ui-auth'
import { requireGitHub } from '../../utils/github-guard'
import { env } from '../../utils/env'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  requireGitHub()
  const state = randomBytes(24).toString('base64url')
  setCookie(event, 'statesman_gh_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().BETTER_AUTH_URL.startsWith('https://'),
    path: '/api/github',
    maxAge: 600
  })
  const slug = env().GITHUB_APP?.slug ?? ''
  return sendRedirect(event, `https://github.com/apps/${slug}/installations/new?state=${state}`)
})
```

`server/api/github/setup.get.ts`:

```ts
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { requireAdmin } from '../../utils/ui-auth'
import { requireGitHub } from '../../utils/github-guard'
import { recordInstallation } from '../../services/sync'
import { recordAuditBestEffort } from '../../services/audit'
import { deploymentOrgId } from '../../utils/deployment-org'

const querySchema = z.object({ installation_id: z.coerce.number().int().positive(), state: z.string().min(1) })

/**
 * GitHub's redirect after an install. Two checks before anything is stored:
 * the state cookie proves this browser started the install here, and asking
 * GitHub about the id with the app's own JWT proves the installation exists and
 * belongs to this app — a forged id fails the second.
 */
export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const client = requireGitHub()
  const query = await getValidatedQuery(event, querySchema.parse)
  const expected = getCookie(event, 'statesman_gh_state') ?? ''
  deleteCookie(event, 'statesman_gh_state', { path: '/api/github' })
  const a = Buffer.from(expected)
  const b = Buffer.from(query.state)
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw createError({ statusCode: 400, statusMessage: 'The install link expired or did not start here. Try Connect GitHub again.' })
  }
  const installation = await client.getInstallation(query.installation_id)
  await recordInstallation(installation.id, installation.accountLogin)
  await recordAuditBestEffort({
    orgId: await deploymentOrgId(),
    actorType: 'user',
    actorId: session.userId,
    action: 'github.install',
    meta: { installationId: installation.id, account: installation.accountLogin }
  })
  return sendRedirect(event, '/?github=connected')
})
```

`server/api/ui/github/installations/[id]/repositories.get.ts`:

```ts
import { z } from 'zod'
import { requireAdmin } from '../../../../../utils/ui-auth'
import { requireGitHub } from '../../../../../utils/github-guard'

const paramsSchema = z.object({ id: z.coerce.number().int().positive() })

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const client = requireGitHub()
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  return client.listRepositories(id)
})
```

`server/api/ui/environments/[id]/link.put.ts`:

```ts
import { z } from 'zod'
import { requireAdmin } from '../../../../utils/ui-auth'
import { requireGitHub } from '../../../../utils/github-guard'
import { environmentContext } from '../../../../services/variables'
import { linkRepository, syncEnvironment } from '../../../../services/sync'
import { recordAuditBestEffort } from '../../../../services/audit'
import { hcl } from '../../../../hcl'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
export const linkInputSchema = z.object({
  installationId: z.number().int().positive(),
  repoId: z.number().int().positive(),
  ref: z.string().min(1).max(255).optional(),
  directory: z.string().max(1024).default('')
})

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const client = requireGitHub()
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const input = await readValidatedBody(event, linkInputSchema.parse)
  const ctx = await environmentContext(id)
  // The repo list comes from GitHub, not the request, so a link can only name
  // a repository this installation can actually read.
  const repo = (await client.listRepositories(input.installationId)).find((r) => r.id === input.repoId)
  if (!repo) throw createError({ statusCode: 400, statusMessage: 'The GitHub App cannot see that repository.' })
  await linkRepository({
    environmentId: id,
    installationId: input.installationId,
    repoId: repo.id,
    repoFullName: repo.fullName,
    ref: input.ref ?? repo.defaultBranch,
    directory: input.directory
  })
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'repository.link',
    meta: { environment: ctx.slug, repo: repo.fullName, ref: input.ref ?? repo.defaultBranch, directory: input.directory }
  })
  return syncEnvironment(id, { client, hcl: await hcl() })
})
```

`server/api/ui/environments/[id]/link.delete.ts`:

```ts
import { z } from 'zod'
import { requireAdmin } from '../../../../utils/ui-auth'
import { environmentContext } from '../../../../services/variables'
import { unlinkRepository } from '../../../../services/sync'
import { recordAuditBestEffort } from '../../../../services/audit'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

/** Works without the app configured, so a deployment that dropped GitHub can still clean up. */
export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const ctx = await environmentContext(id)
  if (!(await unlinkRepository(id))) throw createError({ statusCode: 404, statusMessage: 'This environment is not linked.' })
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'repository.unlink',
    meta: { environment: ctx.slug }
  })
  return { ok: true }
})
```

`server/api/ui/environments/[id]/sync.post.ts`:

```ts
import { z } from 'zod'
import { requireAdmin } from '../../../../utils/ui-auth'
import { requireGitHub } from '../../../../utils/github-guard'
import { environmentContext } from '../../../../services/variables'
import { syncEnvironment } from '../../../../services/sync'
import { recordAuditBestEffort } from '../../../../services/audit'
import { hcl } from '../../../../hcl'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const client = requireGitHub()
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const ctx = await environmentContext(id)
  const result = await syncEnvironment(id, { client, hcl: await hcl() })
  if (!result.ok) {
    await recordAuditBestEffort({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      actorType: 'user',
      actorId: session.userId,
      action: 'repository.sync_failed',
      meta: { environment: ctx.slug, error: result.error }
    })
  }
  return result
})
```

In `variables.get.ts`, replace the `link`/`rows` lines with:

```ts
  const found = await linkSummary(id)
  return {
    environment: { id, slug: ctx.slug },
    link: found?.summary ?? null,
    rows: mergeVariables(await listStoredForUi(id), found?.declared ?? null)
  }
```

(import `linkSummary` from `../../../../services/sync`; drop the `LinkSummary` import and the `const link` line).

`tests/ui/nitro-globals.ts` needs `getValidatedQuery`, `setCookie`, `getCookie`, `deleteCookie` and `sendRedirect` shims only if a test drives those routes beyond the guard. The route-roles tests stop at 401/403/404 before reaching them, so add the shims only if typecheck or a test asks.

- [ ] **Step 5: Run to see them pass**

Run: `pnpm vitest run tests/integration/route-roles.test.ts tests/ui/variables.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/api/github server/api/ui/github.get.ts server/api/ui/github "server/api/ui/environments/[id]" server/utils/github-guard.ts server/utils/deployment-org.ts tests/integration/route-roles.test.ts tests/ui/variables.test.ts
git commit -m "feat: connect a GitHub App and link environments to repositories"
```

---

### Task 15: Webhook

**Files:**
- Create: `server/github/webhook.ts`, `server/api/github/webhook.post.ts`
- Test: `tests/integration/webhook.test.ts`

**Interfaces:**
- Consumes: `verifySignature` (Task 11), Task 13 functions, `SyncDeps`.
- Produces: `handleWebhook(input: { event: string | undefined; signature: string | undefined; rawBody: Uint8Array }, deps: { secret: string; sync: SyncDeps }): Promise<{ status: 202 | 401 | 400; synced: string[] }>`

- [ ] **Step 1: Write the failing tests**

`tests/integration/webhook.test.ts`:

```ts
import '../ui/nitro-globals'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { githubInstallation } from '../../server/db/schema'
import { resetDb, seedProject } from '../protocol/helpers'
import { createEnvironment } from '../../server/services/variables'
import { recordInstallation, linkRepository, linkSummary } from '../../server/services/sync'
import { handleWebhook } from '../../server/github/webhook'
import { GitHubClient } from '../../server/github/client'
import { createHclToolkit, type HclToolkit } from '../../server/hcl/toolkit'

const ORG = 'webhook'
const INSTALLATION = 9_300_001
const SECRET = 'whsec'
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
let hcl: HclToolkit
let envId: string

const client = new GitHubClient({ id: '1', slug: 's', privateKey: pem, webhookSecret: SECRET }, async (input) => {
  const p = new URL(String(input)).pathname
  if (p.endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 })
  if (p === '/repos/acme/infra/commits/main') return new Response('sha-2')
  if (p === '/repos/acme/infra/contents/') return new Response(JSON.stringify([{ type: 'file', name: 'v.tf', path: 'v.tf' }]))
  if (p === '/repos/acme/infra/contents/v.tf') return new Response('variable "from_push" {}\n')
  return new Response('{"message":"Not Found"}', { status: 404 })
})

const deliver = (event: string, payload: unknown, secret = SECRET) => {
  const rawBody = Buffer.from(JSON.stringify(payload))
  const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  return handleWebhook({ event, signature, rawBody }, { secret: SECRET, sync: { client, hcl } })
}

beforeAll(async () => {
  hcl = await createHclToolkit(async (name) => readFileSync(join('server/assets/wasm', name)))
})

beforeEach(async () => {
  await resetDb(ORG)
  await db().delete(githubInstallation).where(eq(githubInstallation.installationId, INSTALLATION))
  const projectId = await seedProject(ORG, 'p')
  envId = (await createEnvironment(projectId, 'dev')).id
  await recordInstallation(INSTALLATION, 'acme')
  await linkRepository({ environmentId: envId, installationId: INSTALLATION, repoId: 88, repoFullName: 'acme/infra', ref: 'main', directory: '' })
})

describe('handleWebhook', () => {
  it('refuses a bad signature with 401 and does nothing', async () => {
    const result = await deliver('push', { ref: 'refs/heads/main', repository: { id: 88, full_name: 'acme/infra' } }, 'wrong')
    expect(result).toEqual({ status: 401, synced: [] })
    expect((await linkSummary(envId))?.declared).toBeNull()
  })

  it('syncs every environment linked to the pushed branch', async () => {
    const result = await deliver('push', { ref: 'refs/heads/main', repository: { id: 88, full_name: 'acme/infra' } })
    expect(result).toEqual({ status: 202, synced: [envId] })
    expect((await linkSummary(envId))?.declared?.map((d) => d.name)).toEqual(['from_push'])
  })

  it('ignores a push to another branch or a tag', async () => {
    expect((await deliver('push', { ref: 'refs/heads/dev', repository: { id: 88, full_name: 'acme/infra' } })).synced).toEqual([])
    expect((await deliver('push', { ref: 'refs/tags/main', repository: { id: 88, full_name: 'acme/infra' } })).synced).toEqual([])
  })

  it('follows a repository rename', async () => {
    await deliver('push', { ref: 'refs/heads/dev', repository: { id: 88, full_name: 'acme/infrastructure' } })
    expect((await linkSummary(envId))?.summary.repoFullName).toBe('acme/infrastructure')
  })

  it('drops links when the installation is deleted', async () => {
    await deliver('installation', { action: 'deleted', installation: { id: INSTALLATION } })
    expect(await linkSummary(envId)).toBeNull()
  })

  it('marks links when repository access is removed', async () => {
    await deliver('installation_repositories', {
      action: 'removed',
      installation: { id: INSTALLATION },
      repositories_removed: [{ id: 88 }]
    })
    expect((await linkSummary(envId))?.summary.lastSyncError).toMatch(/no longer has access/)
  })

  it('accepts and ignores other events', async () => {
    expect(await deliver('ping', { zen: 'hi' })).toEqual({ status: 202, synced: [] })
  })

  it('answers 400 to a signed body that is not JSON', async () => {
    const rawBody = Buffer.from('not json')
    const signature = `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`
    expect((await handleWebhook({ event: 'push', signature, rawBody }, { secret: SECRET, sync: { client, hcl } })).status).toBe(400)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run tests/integration/webhook.test.ts`
Expected: FAIL. Module not found.

- [ ] **Step 3: Implement**

`server/github/webhook.ts`:

```ts
import { z } from 'zod'
import { verifySignature } from './signature'
import {
  linksForPush,
  markRepositoriesRevoked,
  removeInstallation,
  renameRepository,
  syncEnvironment,
  type SyncDeps
} from '../services/sync'

const pushSchema = z.object({ ref: z.string(), repository: z.object({ id: z.number(), full_name: z.string() }) })
const installationSchema = z.object({ action: z.string(), installation: z.object({ id: z.number() }) })
const reposRemovedSchema = installationSchema.extend({
  repositories_removed: z.array(z.object({ id: z.number() })).default([])
})

/**
 * Pure of h3 so every branch is testable with bytes in and a status out. The
 * signature is checked on the raw body before it is parsed (variables spec §9).
 */
export async function handleWebhook(
  input: { event: string | undefined; signature: string | undefined; rawBody: Uint8Array },
  deps: { secret: string; sync: SyncDeps }
): Promise<{ status: 202 | 401 | 400; synced: string[] }> {
  if (!verifySignature(deps.secret, input.rawBody, input.signature)) return { status: 401, synced: [] }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(input.rawBody).toString('utf8'))
  } catch {
    return { status: 400, synced: [] }
  }

  if (input.event === 'push') {
    const push = pushSchema.safeParse(payload)
    if (!push.success) return { status: 400, synced: [] }
    await renameRepository(push.data.repository.id, push.data.repository.full_name)
    if (!push.data.ref.startsWith('refs/heads/')) return { status: 202, synced: [] }
    const branch = push.data.ref.slice('refs/heads/'.length)
    const environments = await linksForPush(push.data.repository.id, branch)
    // Sequential: a handful of small fetches each, and GitHub retries a
    // delivery that times out, so parallelism would buy nothing but rate limit.
    for (const id of environments) await syncEnvironment(id, deps.sync)
    return { status: 202, synced: environments }
  }

  if (input.event === 'installation') {
    const parsed = installationSchema.safeParse(payload)
    if (parsed.success && parsed.data.action === 'deleted') await removeInstallation(parsed.data.installation.id)
    return { status: 202, synced: [] }
  }

  if (input.event === 'installation_repositories') {
    const parsed = reposRemovedSchema.safeParse(payload)
    if (parsed.success && parsed.data.action === 'removed') {
      await markRepositoriesRevoked(
        parsed.data.installation.id,
        parsed.data.repositories_removed.map((r) => r.id)
      )
    }
    return { status: 202, synced: [] }
  }

  return { status: 202, synced: [] }
}
```

`server/api/github/webhook.post.ts`:

```ts
import { requireGitHub } from '../../utils/github-guard'
import { env } from '../../utils/env'
import { handleWebhook } from '../../github/webhook'
import { hcl } from '../../hcl'

export default defineEventHandler(async (event) => {
  const client = requireGitHub()
  const rawBody = (await readRawBody(event, false)) ?? Buffer.alloc(0)
  const result = await handleWebhook(
    {
      event: getRequestHeader(event, 'x-github-event'),
      signature: getRequestHeader(event, 'x-hub-signature-256'),
      rawBody
    },
    { secret: env().GITHUB_APP?.webhookSecret ?? '', sync: { client, hcl: await hcl() } }
  )
  setResponseStatus(event, result.status)
  return { synced: result.synced.length }
})
```

`removeInstallation` from a webhook is not audited: the delivery has no actor and the audit table needs one. The `github.uninstall` audit action is written only by this path. Add a `recordAuditBestEffort` with `actorType: 'user'`, no `actorId`, `orgId: await deploymentOrgId()`, `action: 'github.uninstall'` inside the `installation.deleted` branch of the route by returning the event kind from `handleWebhook`. If that complicates the pure function, record the uninstall in `handleWebhook` via an injected `audit` callback. Pick whichever keeps `handleWebhook` testable; the test above needs no audit assertion.

- [ ] **Step 4: Run to see it pass**

Run: `pnpm vitest run tests/integration/webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/github/webhook.ts server/api/github/webhook.post.ts tests/integration/webhook.test.ts
git commit -m "feat: resync linked environments on GitHub push webhooks"
```

---

### Task 16: GitHub UI

**Files:**
- Create: `app/components/RepositoryPanel.vue`, `app/components/RepositoryLinkModal.vue`
- Modify: `app/components/VariablesPanel.vue`

**Interfaces:**
- Consumes: `GET /api/ui/github`, the `link` field of the variables route, and the link, sync and repositories routes.

- [ ] **Step 1: Build**

`RepositoryPanel.vue`: props `environmentId: string` and `link: LinkSummary | null`; emits `changed`. `useFetch('/api/ui/github')`.
- If `configured` is false, render nothing.
- No link, admin, no installations: a **Connect GitHub** button whose `href` is `installUrl`. It is a real navigation, not `$fetch`, because it redirects to GitHub.
- No link, admin, has installations: a **Link repository** button that opens `RepositoryLinkModal`.
- Linked: text "`<repoFullName>` · `<ref>` · `/<directory>`", "Synced <relative lastSyncedAt>" or "Not synced yet", and for admins **Sync now** (POST, then emit `changed`) and **Unlink** (confirmation modal).
- `lastSyncError` non-null: a `UAlert` (color `error`), open, with the message.
- A closed `<details>` "Technical details" containing `lastSyncedSha` with a copy button (the clipboard pattern from `ProjectCreateModal.vue`).

`RepositoryLinkModal.vue`: an installation `USelect`, rendered only when there is more than one installation and otherwise using the only one silently. A repository `USelect` from `/api/ui/github/installations/:id/repositories` (searchable via `USelectMenu`). Branch `UInput`, placeholder showing the repo's default branch. Directory `UInput`, placeholder `envs/prod (empty for the repository root)`. On submit, PUT `/link`. Show the returned `SyncResult`: on `ok`, close and emit; on `!ok`, keep the modal open, show the error, and say "Linked. The first sync failed:" because the link itself was saved.

`VariablesPanel.vue`: render `<RepositoryPanel :environment-id="envId" :link="data.link" @changed="refresh()" />` above the table.

- [ ] **Step 2: Verify against a real GitHub App**

This step is manual and cannot run in CI. Create a test app per `docs/github-app.md` (written in Task 18; draft it now if needed). Point a tunnel (`cloudflared tunnel --url http://localhost:3000`) at `pnpm dev`, and set `BETTER_AUTH_URL` and the four `GITHUB_APP_*` variables. Then:
1. Connect GitHub; the redirect returns to `/?github=connected`.
2. Link a repo whose directory declares at least one variable without a default. The status column appears with that variable as **Missing**.
3. Push a commit that adds a variable. Within seconds of the webhook delivery (check the app's "Recent Deliveries": 202), reloading shows it.
4. Link a directory that does not exist: the error alert names it.
5. Screenshot the linked panel and the error state, and check the right edge of the panel and the alert.

Record in the commit message which of these were exercised.

- [ ] **Step 3: Commit**

```bash
git add app/components/RepositoryPanel.vue app/components/RepositoryLinkModal.vue app/components/VariablesPanel.vue
git commit -m "feat: link a repository to an environment from the variables tab"
```

---

### Task 17: End-to-end with real Terraform

**Files:**
- Create: `tests/e2e/fixture-vars/main.tf`, `tests/e2e/variables.test.ts`

- [ ] **Step 1: Write the fixture**

`tests/e2e/fixture-vars/main.tf`:

```hcl
# Local state on purpose: this run tests variable delivery, not the backend,
# which tests/e2e/scenario.ts already covers.
terraform {
  required_version = ">= 1.6"
}

variable "value" {
  type    = string
  default = "one"
}

variable "replicas" {
  type = number
}

resource "terraform_data" "canary" {
  input = "${var.value}-${var.replicas}"
}

output "canary" {
  value = terraform_data.canary.output
}
```

- [ ] **Step 2: Write the test**

`tests/e2e/variables.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { auth } from '../../server/utils/auth'
import { createEnvironment, setVariable } from '../../server/services/variables'
import { resetDb, seedProject, provisionUser } from '../protocol/helpers'
import '../ui/nitro-globals'

await setup({ server: true })

const run = promisify(execFile)
const ORG = 'tf-vars'
let dir: string
let token: string

beforeAll(async () => {
  await resetDb(ORG)
  const projectId = await seedProject(ORG, 'app')
  const user = await provisionUser(`tfvars-${Date.now()}@example.com`, 'correct horse battery', 'admin')
  const env = await createEnvironment(projectId, 'production')
  await setVariable({ environmentId: env.id, name: 'value', input: { value: 'two', sensitive: true }, userId: user.id })
  await setVariable({ environmentId: env.id, name: 'replicas', input: { value: 3, sensitive: false }, userId: user.id })
  token = (
    await auth.api.createApiKey({
      body: {
        userId: user.id,
        name: 'tfvars-e2e',
        permissions: { state: [], vars: ['read'] },
        metadata: { scope: { kind: 'projects', projects: [`${ORG}/app`] } }
      }
    })
  ).key
  dir = await mkdtemp(join(tmpdir(), 'statesman-vars-'))
  await cp(fileURLToPath(new URL('fixture-vars', import.meta.url)), dir, { recursive: true })
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('real terraform with delivered variables', () => {
  it('applies with the downloaded file and no -var flags', async () => {
    // The documented recipe, minus curl: the same request, the same file name.
    const response = await fetch(absoluteUrl(`/api/vars/${ORG}/app/production`), {
      headers: { authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` }
    })
    expect(response.status).toBe(200)
    await writeFile(join(dir, 'statesman.auto.tfvars.json'), await response.text())

    const env = { ...process.env, TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' }
    await run('terraform', ['init', '-no-color'], { cwd: dir, env })
    await run('terraform', ['apply', '-auto-approve', '-no-color'], { cwd: dir, env })
    const { stdout } = await run('terraform', ['output', '-raw', 'canary'], { cwd: dir, env })
    expect(stdout.trim()).toBe('two-3')
  })
})
```

- [ ] **Step 3: Run it**

Run: `pnpm test:e2e`
Expected: PASS, including the existing local and S3 scenarios. The new test fails before Task 6 exists and passes after.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/fixture-vars tests/e2e/variables.test.ts
git commit -m "test: apply real terraform with delivered variables"
```

---

### Task 18: Manual

**Files:**
- Modify: `README.md`, `docs/deploy-docker.md`, `docs/deploy-vercel.md`, `docs/superpowers/specs/2026-09-04-statesman-design.md`
- Create: `docs/github-app.md`

- [ ] **Step 1: README**

Read the README's existing sections and match their tone and heading levels. Add:
- A **Variables** section after "Point Terraform at it": environments; adding, editing and importing variables; sensitive meaning write-only; the curl recipe; the `.gitignore` line `statesman.auto.tfvars.json`; the fact that undeclared values cause a Terraform warning, not a failure; and a link to `docs/github-app.md`.
- In the roles table, the rows from spec §7. Adjust the "both roles read every project's decrypted state" warning to add: "and every non-sensitive variable. Sensitive variables are readable only with a token that has variable access."
- In the token section, the "Read Variables" permission, and the fact that existing tokens do not have it.
- In the key-loss warning: "state **and variables**".
- In the operator list (near `user:create`), `pnpm vendor:wasm`: when to run it (after bumping `web-tree-sitter` or the grammar) and that the unit test fails until you do.

- [ ] **Step 2: docs/github-app.md**

Cover, in order:
1. What it does and does not do: read-only, never writes, optional.
2. Registering: GitHub → Settings → Developer settings → GitHub Apps → New. Name, Homepage URL = `BETTER_AUTH_URL`, **Setup URL** = `<BETTER_AUTH_URL>/api/github/setup` with "Redirect on update" ticked, **Webhook URL** = `<BETTER_AUTH_URL>/api/github/webhook`, a webhook secret (`openssl rand -hex 32`). **Repository permissions:** Contents read-only, Metadata read-only. **Subscribe to events:** Push. "Where can this app be installed": Only on this account.
3. Generating the private key and putting it in `GITHUB_APP_PRIVATE_KEY` (multi-line in `.env`, or one line with `\n` on hosting panels).
4. The four variables, all or none, and the boot error you get otherwise. Quote its exact text.
5. Connecting: **Connect GitHub** on a project's Variables tab (admin).
6. Linking: branch, directory, root modules only, subdirectories not read.
7. Verifying: the app's Advanced → Recent Deliveries shows 202 for a push. 401 means a secret mismatch.
8. Troubleshooting: each `lastSyncError` message the code can produce, with its cause. Grep `server/services/sync.ts` and `server/github/client.ts` for them.

- [ ] **Step 3: Deploy docs**

Add the four `GITHUB_APP_*` rows to the environment variable tables in `docs/deploy-docker.md` and `docs/deploy-vercel.md`, Required = "No (all four or none)", with a link to `docs/github-app.md`. In `deploy-docker.md`'s compose example, add them as `${GITHUB_APP_ID:-}`, which is optional and not the `:?` form.

- [ ] **Step 4: Base spec note**

At the top of `docs/superpowers/specs/2026-09-04-statesman-design.md`, under the existing 2026-09-08 note:

```markdown
> **Later change, 2026-10-09.** Variables were added alongside state — see
> [2026-10-09-variables-design.md](2026-10-09-variables-design.md). The §4
> sentence that every account reads every project's secrets now has one
> exception: sensitive variables are write-only in the dashboard.
```

Update the variables spec's **Status** to "Implemented."

- [ ] **Step 5: Check the manual against the code**

For every route, env var, permission and error message the docs name, confirm it exists by grepping for it. Run `pnpm format:check`.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/github-app.md docs/deploy-docker.md docs/deploy-vercel.md docs/superpowers/specs
git commit -m "docs: describe variables, delivery and the GitHub App"
```

---

## Final verification

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`, all green. Paste the summary lines.
- [ ] `git diff main --stat`: no file outside the file map changed without a reason.
- [ ] Prove the behaviour changed: on `main`, `curl -i …/api/vars/acme/prod/default` answers 404 (no route). On the branch, it answers 200 with the file, given a vars token.
- [ ] Prove existing tokens are unaffected: a token created on `main` (state-only) still runs `terraform plan` against the branch, and gets 403 from `/api/vars/…`.
