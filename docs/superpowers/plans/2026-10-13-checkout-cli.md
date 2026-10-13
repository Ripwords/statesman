# Checkout CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `statesman pull` / `statesman status` CLI that writes and checks a Terraform root's per-environment files (vars, backend config, `.env`) from what statesman stores, plus the per-environment backend settings it needs.

**Architecture:** The server gains one nullable `backend` column on `environment`, an owner-only route to edit it (JSON or pasted HCL), a dashboard panel, and a token route `GET /api/checkout/:org/:project/:environment` returning `{ variables, backend }`. The CLI lives in `cli/src/` inside the root package, imports `shared/` (schemas, `toTfvars`) and the HCL toolkit directly, and is bundled by esbuild into `cli/dist/statesman.mjs` with the two wasm files beside it. Pure modules (render, env-file merge, compare, strays) are separated from I/O (HTTP client, git, filesystem, commands).

**Tech Stack:** Nuxt 4 / Nitro / h3, Drizzle (Postgres), Zod 4, Better Auth API keys, web-tree-sitter HCL toolkit, Vitest, Nuxt UI 4, esbuild, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-13-checkout-cli-design.md`

## Global Constraints

- Node 24; TypeScript; no `any`; `as unknown as X` only where unavoidable.
- No new runtime dependency. `esbuild` is added as a devDependency only.
- The CLI never prints a variable value: not on a TTY, not in `--json`, not in an error.
- The CLI never prompts. Token from `STATESMAN_TOKEN` only; `STATESMAN_URL` overrides `server`.
- Exit codes: `0` current, `1` drift (missing, differs, unreadable, stray, refused), `2` could not check.
- Backend setting keys: `^[a-z][a-z0-9_]*$`, at most 32; values string ≤ 2048 chars, number, boolean. Refused keys: `access_key`, `secret_key`, `token`, `password`, and any ending `_secret`, `_token`, `_password`.
- Manifest file patterns: `^[A-Za-z0-9._{}-]+$`, not `.` or `..`. With 2+ environments every pattern contains `{env}`, and `files.vars` may not be `terraform.tfvars`, `terraform.tfvars.json`, or end in `.auto.tfvars` / `.auto.tfvars.json`.
- `.env` owned keys: `TF_DATA_DIR`, `TF_CLI_ARGS_init`, `TF_CLI_ARGS_{plan,apply,destroy,import,refresh,console}`.
- Vars files are written with mode `0600`. Every write is temp-file-then-rename.
- Audit metadata never holds values.
- Commits are Conventional Commits; stage explicit paths, never `git add -A`.

## Review Focus

1. **A hand-formatted local `.tfvars` with the same values** must report `ok`, not `differs`. Pinned in Task 6 (comparison test with reordered keys and different spacing).
2. **A committed `.env.example` beside `.env.{env}` files** must not be reported as stray. Pinned in Task 6 (strays exclude git-tracked files) and Task 8 (git integration).
3. **A `.env` file with Windows line endings, `export ` prefixes, or quoted values** must merge without duplicating owned keys or dropping foreign lines. Pinned in Task 6.
4. **Pasting an existing `backend.hcl` that contains a nested block or an expression** must give a 400 with a line-numbered message, not a 500. Pinned in Task 3.
5. **Running `pull` in CI with the token unset or the server unreachable** must exit 2 with the fix in the message, before writing anything. Pinned in Task 8.

---

## File map

| Path | Responsibility |
|---|---|
| `shared/hcl/tfvars.ts` | `toTfvars` (moved from `server/hcl/tfvars.ts`) |
| `shared/schemas/backend.ts` | Backend settings schema, credential-key rule, PUT body schema |
| `shared/schemas/manifest.ts` | `statesman.json` schema, `fileFor`, `formatManifestError` |
| `server/db/schema.ts` | `environment.backend` column |
| `drizzle/0005_*.sql` | Migration (generated) |
| `server/services/variables.ts` | `setBackend`, `readBackend`, `listEnvironments` returns `backend` |
| `server/utils/project-access.ts`, `shared/project-permissions.ts` | `environment:configure` permission (owner) |
| `server/api/ui/environments/[id]/backend.put.ts` | Edit backend settings |
| `server/api/checkout/[org]/[project]/[environment].get.ts` | Token delivery |
| `app/components/BackendSettingsPanel.vue` | Dashboard panel |
| `app/components/VariablesPanel.vue` | Mounts the panel |
| `cli/src/render.ts` | Desired file contents from a checkout |
| `cli/src/env-file.ts` | Owned `.env` entries, merge, compare |
| `cli/src/compare.ts` | Parse local vars/backend file, name-only diff |
| `cli/src/strays.ts` | Stray detection |
| `cli/src/errors.ts` | `CliError` with exit code |
| `cli/src/client.ts` | HTTP client for `/api/checkout` |
| `cli/src/git.ts` | `check-ignore`, `ls-files` |
| `cli/src/files.ts` | Atomic write, read-or-null |
| `cli/src/wasm.ts` | Locate wasm, build toolkit |
| `cli/src/report.ts` | Per-file reports, the core of `status` and `pull` |
| `cli/src/commands.ts` | `status`, `pull` |
| `cli/src/output.ts` | Text table and JSON |
| `cli/src/main.ts` | Argument parsing, exit codes |
| `scripts/build-cli.ts` | esbuild bundle + wasm copy |
| `docs/cli.md`, `README.md`, `docs/backend-config.md` | Docs |

---

### Task 1: Move `toTfvars` to `shared/`

**Files:**
- Move: `server/hcl/tfvars.ts` → `shared/hcl/tfvars.ts`
- Modify: `server/api/ui/environments/[id]/variables/download.get.ts`, `server/api/vars/[org]/[project]/[environment].get.ts`, `tests/unit/tfvars-writer.test.ts`, `tests/e2e/tfvars-fidelity.test.ts` (import paths)
- Create: `tests/unit/fixtures/tfvars/golden.tfvars`, `tests/unit/tfvars-golden.test.ts`

**Interfaces:**
- Produces: `toTfvars(values: Record<string, JsonValue>): string` from `shared/hcl/tfvars.ts`

- [ ] **Step 1: Write the golden test against the current location**

`tests/unit/tfvars-golden.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { toTfvars } from '../../server/hcl/tfvars'
import { GOLDEN_INPUT } from './fixtures/tfvars/golden-input'

// Output of toTfvars before it moved to shared/. Any change to this text is a
// change to every file the dashboard, /api/vars and the CLI write.
describe('toTfvars golden output', () => {
  it('matches the recorded output byte for byte', () => {
    const golden = readFileSync('tests/unit/fixtures/tfvars/golden.tfvars', 'utf8')
    expect(toTfvars(GOLDEN_INPUT)).toBe(golden)
  })
})
```

- [ ] **Step 2: Record the golden file from the current code**

Run:
`tests/unit/fixtures/tfvars/golden-input.ts` (kept out of the test file so a plain script can load it):
```ts
import type { JsonValue } from '../../../../shared/schemas/variable'

export const GOLDEN_INPUT: Record<string, JsonValue> = {
  region: 'ap-southeast-1',
  count: 3,
  ratio: 1e-7,
  enabled: true,
  nothing: null,
  tricky: 'a "quote" \\ ${not_interp} %{not_directive} $${x}\u0007',
  list: ['a', 1, false],
  tags: { team: 'core', 'needs-quote': 'x' }
}
```
Then record the output:
```bash
mkdir -p tests/unit/fixtures/tfvars
pnpm tsx -e "const {toTfvars}=await import('./server/hcl/tfvars.ts'); const {GOLDEN_INPUT}=await import('./tests/unit/fixtures/tfvars/golden-input.ts'); process.stdout.write(toTfvars(GOLDEN_INPUT))" > tests/unit/fixtures/tfvars/golden.tfvars
```
Inspect the file: it must be non-empty and end in a newline.

- [ ] **Step 3: Run the test, expect PASS**

Run: `pnpm vitest run tests/unit/tfvars-golden.test.ts`
Expected: PASS (it pins current behaviour).

- [ ] **Step 4: Move the file and update every importer**

```bash
mkdir -p shared/hcl
git mv server/hcl/tfvars.ts shared/hcl/tfvars.ts
```
In `shared/hcl/tfvars.ts` change `import type { JsonValue } from '../../shared/schemas/variable'` to `import type { JsonValue } from '../schemas/variable'`.
Update imports (`grep -rn "hcl/tfvars" server app tests`):
- `server/api/vars/[org]/[project]/[environment].get.ts`: `import { toTfvars } from '../../../../../shared/hcl/tfvars'`
- `server/api/ui/environments/[id]/variables/download.get.ts`: `'../../../../../../shared/hcl/tfvars'`
- `tests/unit/tfvars-writer.test.ts`, `tests/e2e/tfvars-fidelity.test.ts`, `tests/unit/tfvars-golden.test.ts`: `'../../shared/hcl/tfvars'`

- [ ] **Step 5: Run unit tests and typecheck**

Run: `pnpm vitest run tests/unit && pnpm typecheck`
Expected: PASS, golden test still byte-identical.

- [ ] **Step 6: Commit**

```bash
git add shared/hcl/tfvars.ts server/hcl/tfvars.ts server/api/vars server/api/ui/environments tests/unit/tfvars-golden.test.ts tests/unit/fixtures/tfvars tests/unit/tfvars-writer.test.ts tests/e2e/tfvars-fidelity.test.ts
git commit -m "refactor: move toTfvars to shared so the CLI can render with it"
```

---

### Task 2: Backend settings schema

**Files:**
- Create: `shared/schemas/backend.ts`, `tests/unit/backend-schema.test.ts`

**Interfaces:**
- Produces:
  - `MAX_BACKEND_KEYS = 32`
  - `isCredentialKey(key: string): boolean`
  - `backendSettingsSchema: ZodType<BackendSettings>`; `type BackendSettings = Record<string, string | number | boolean>`
  - `putBackendSchema` — body `{ backend: BackendSettings | null } | { hcl: string }`
  - `firstIssueMessage(error: z.ZodError): string`

- [ ] **Step 1: Write the failing tests**

`tests/unit/backend-schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import {
  backendSettingsSchema,
  firstIssueMessage,
  isCredentialKey,
  putBackendSchema
} from '../../shared/schemas/backend'

const parse = (v: unknown) => backendSettingsSchema.safeParse(v)

describe('backendSettingsSchema', () => {
  it('accepts a flat map of strings, numbers and booleans', () => {
    const r = parse({ bucket: 'b', region: 'ap-southeast-1', encrypt: true, max_retries: 5 })
    expect(r.success).toBe(true)
  })

  it.each(['access_key', 'secret_key', 'token', 'password', 'client_secret', 'sas_token', 'db_password'])(
    'refuses credential-like key %s and names it',
    (key) => {
      const r = parse({ [key]: 'x' })
      expect(r.success).toBe(false)
      if (!r.success) {
        const message = firstIssueMessage(r.error)
        expect(message).toContain(key)
        expect(message).toContain('unencrypted')
      }
    }
  )

  it('refuses keys that are not lowercase identifiers', () => {
    for (const key of ['ACCESS_KEY', 'Bucket', '1bucket', 'bad-key', '']) {
      expect(parse({ [key]: 'x' }).success).toBe(false)
    }
  })

  it('refuses nested values and null', () => {
    expect(parse({ assume_role: { role_arn: 'x' } }).success).toBe(false)
    expect(parse({ list: ['a'] }).success).toBe(false)
    expect(parse({ empty: null }).success).toBe(false)
  })

  it('refuses a string longer than 2048 characters', () => {
    expect(parse({ bucket: 'x'.repeat(2049) }).success).toBe(false)
    expect(parse({ bucket: 'x'.repeat(2048) }).success).toBe(true)
  })

  it('refuses more than 32 keys', () => {
    const map = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']))
    expect(parse(map).success).toBe(false)
  })

  it('isCredentialKey does not flag ordinary keys', () => {
    for (const key of ['bucket', 'kms_key_id', 'token_endpoint', 'use_lockfile']) {
      expect(isCredentialKey(key)).toBe(false)
    }
  })
})

describe('putBackendSchema', () => {
  it('takes a map, null, or HCL text', () => {
    expect(putBackendSchema.safeParse({ backend: { bucket: 'b' } }).success).toBe(true)
    expect(putBackendSchema.safeParse({ backend: null }).success).toBe(true)
    expect(putBackendSchema.safeParse({ hcl: 'bucket = "b"' }).success).toBe(true)
    expect(putBackendSchema.safeParse({}).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm vitest run tests/unit/backend-schema.test.ts`
Expected: FAIL, cannot resolve `shared/schemas/backend`.

- [ ] **Step 3: Implement**

`shared/schemas/backend.ts`:
```ts
import { z } from 'zod'

export const MAX_BACKEND_KEYS = 32

const CREDENTIAL_KEYS = new Set(['access_key', 'secret_key', 'token', 'password'])
const CREDENTIAL_SUFFIXES = ['_secret', '_token', '_password']

/**
 * Backend settings are stored and shown in plaintext (checkout spec §3), so a
 * key that names a credential is refused rather than encrypted.
 */
export function isCredentialKey(key: string): boolean {
  const k = key.toLowerCase()
  return CREDENTIAL_KEYS.has(k) || CREDENTIAL_SUFFIXES.some((s) => k.endsWith(s))
}

const keySchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Backend setting names use lowercase letters, digits and underscores, and start with a letter.'
  )

const valueSchema = z.union([z.string().max(2048), z.number(), z.boolean()])

export const backendSettingsSchema = z
  .record(keySchema, valueSchema)
  .superRefine((map, ctx) => {
    const keys = Object.keys(map)
    if (keys.length > MAX_BACKEND_KEYS) {
      ctx.addIssue({ code: 'custom', message: `At most ${MAX_BACKEND_KEYS} backend settings.` })
    }
    for (const key of keys) {
      if (isCredentialKey(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            `${key} looks like a credential. Backend settings are stored unencrypted, so ` +
            `use the provider's credential chain, or TF_HTTP_PASSWORD for statesman's own backend.`
        })
      }
    }
  })

export type BackendSettings = Record<string, string | number | boolean>

export const putBackendSchema = z.union([
  z.object({ backend: backendSettingsSchema.nullable() }).strict(),
  z.object({ hcl: z.string().max(65_536) }).strict()
])
export type PutBackendInput = z.infer<typeof putBackendSchema>

export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid backend settings'
  // A refused key reports through its path; the message already names it.
  return issue.message
}
```
Note: for a bad *key* (regex failure) Zod reports the issue on the key path; the message is the regex message. That is acceptable: the credential messages name the key explicitly, as the test requires.

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm vitest run tests/unit/backend-schema.test.ts`
Expected: PASS. If `z.record` with a regex key schema reports the credential issue before the regex (or vice versa) for a key like `client_secret`, the test still passes because `client_secret` matches the regex.

- [ ] **Step 5: Commit**

```bash
git add shared/schemas/backend.ts tests/unit/backend-schema.test.ts
git commit -m "feat: backend settings schema that refuses credential-like keys"
```

---

### Task 3: Store and edit backend settings

**Files:**
- Modify: `server/db/schema.ts` (environment table), `server/services/variables.ts`, `server/utils/project-access.ts`, `shared/project-permissions.ts`, `tests/integration/route-roles.test.ts`
- Create: `drizzle/0005_*.sql` (generated), `server/api/ui/environments/[id]/backend.put.ts`, `tests/integration/backend-settings.test.ts`

**Interfaces:**
- Consumes: `backendSettingsSchema`, `putBackendSchema`, `firstIssueMessage`, `BackendSettings` (Task 2)
- Produces:
  - `setBackend(environmentId: string, backend: BackendSettings | null): Promise<void>`
  - `readBackend(environmentId: string): Promise<BackendSettings | null>`
  - `listEnvironments(projectId)` now returns `Array<{ id: string; slug: string; backend: BackendSettings | null }>`
  - Permission `'environment:configure'` (owner and admin)
  - `PUT /api/ui/environments/:id/backend` → `{ backend: BackendSettings | null }`

- [ ] **Step 1: Write the failing integration test**

`tests/integration/backend-settings.test.ts`:
```ts
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
  })

  it('refuses an editor with 403', async () => {
    expect((await statusOf(put(editor, { backend: null }))).status).toBe(403)
  })

  it('audits key names, never values', async () => {
    await put(owner, { backend: { bucket: 'audit-me' } })
    const rows = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'environment.backend.update'), eq(auditLog.projectId, projectId)))
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
```
Check `auditLog`'s column names (`projectId`, `metaJson`) against `server/db/schema.ts` before running and adjust the test if they differ.

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm vitest run tests/integration/backend-settings.test.ts`
Expected: FAIL, cannot resolve `backend.put`.

- [ ] **Step 3: Add the column and generate the migration**

In `server/db/schema.ts`, add the import `import type { BackendSettings } from '../../shared/schemas/backend'` and the column to `environment`:
```ts
    slug: text('slug').notNull(),
    // Non-secret, shown in full (checkout spec §3). Null: no backend file.
    backend: jsonb('backend').$type<BackendSettings>(),
    createdAt: timestamp('created_at').notNull().defaultNow()
```
Run: `pnpm db:generate` and confirm a new `drizzle/0005_*.sql` containing only `ALTER TABLE "environment" ADD COLUMN "backend" jsonb;`. Then `pnpm db:migrate:test`.

- [ ] **Step 4: Add the permission**

`shared/project-permissions.ts`: add `| 'environment:configure'` to the union and `'environment:configure': 'owner',` to `MIN_ROLE`.
`server/utils/project-access.ts`: add `'configure'` to the `environment` statement array (line ~20) and to the owner role's `environment` list; add `'environment:configure': { environment: ['configure'] },` to `REQUESTS`.

- [ ] **Step 5: Add the service functions**

In `server/services/variables.ts`, add the import `import type { BackendSettings } from '../../shared/schemas/backend'`, change `listEnvironments`, and add two functions:
```ts
export async function listEnvironments(
  projectId: string
): Promise<Array<{ id: string; slug: string; backend: BackendSettings | null }>> {
  return db()
    .select({ id: environment.id, slug: environment.slug, backend: environment.backend })
    .from(environment)
    .where(eq(environment.projectId, projectId))
    .orderBy(asc(environment.slug))
}

export async function setBackend(
  environmentId: string,
  backend: BackendSettings | null
): Promise<void> {
  await db().update(environment).set({ backend }).where(eq(environment.id, environmentId))
}

export async function readBackend(environmentId: string): Promise<BackendSettings | null> {
  const rows = await db()
    .select({ backend: environment.backend })
    .from(environment)
    .where(eq(environment.id, environmentId))
  return rows[0]?.backend ?? null
}
```
Also change the comment on `readDeliveryValues` from "Its one caller is the token door." to "Its callers are the token doors: /api/vars and /api/checkout."

- [ ] **Step 6: Add the route**

`server/api/ui/environments/[id]/backend.put.ts`:
```ts
import { z } from 'zod'
import { requireSession } from '../../../../utils/ui-auth'
import { projectIdOfEnvironment, requireProjectPermission } from '../../../../utils/project-access'
import { environmentContext, setBackend } from '../../../../services/variables'
import { recordAuditBestEffort } from '../../../../services/audit'
import { hcl } from '../../../../hcl'
import { HclError } from '../../../../hcl/toolkit'
import {
  backendSettingsSchema,
  firstIssueMessage,
  putBackendSchema,
  type BackendSettings
} from '../../../../../shared/schemas/backend'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

function badRequest(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message })
}

/** Backend settings (checkout spec §4). JSON or pasted HCL; empty HCL clears. */
export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const session = await requireProjectPermission(
    event,
    await projectIdOfEnvironment(id),
    'environment:configure'
  )
  const body = putBackendSchema.safeParse(await readBody(event))
  if (!body.success) badRequest(firstIssueMessage(body.error))

  let backend: BackendSettings | null
  if ('backend' in body.data) {
    backend = body.data.backend
  } else if (body.data.hcl.trim() === '') {
    backend = null
  } else {
    let parsed: unknown
    try {
      parsed = (await hcl()).parseTfvars(body.data.hcl)
    } catch (error) {
      if (error instanceof HclError) badRequest(error.message)
      throw error
    }
    const checked = backendSettingsSchema.safeParse(parsed)
    if (!checked.success) badRequest(firstIssueMessage(checked.error))
    backend = checked.data
  }

  const ctx = await environmentContext(id)
  await setBackend(id, backend)
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'environment.backend.update',
    meta: { environment: ctx.slug, keys: backend ? Object.keys(backend) : [] }
  })
  return { backend }
})
```
If `parseTfvars` accepts `assume_role = { role_arn = "x" }` as an object value, `backendSettingsSchema` refuses it (object value); the message then comes from the value union. That satisfies the 400 test without a line number; only the expression case asserts `:2:`.

- [ ] **Step 7: Add the route to the roles matrix**

In `tests/integration/route-roles.test.ts`, import `import putBackend from '../../server/api/ui/environments/[id]/backend.put'` and add to `ROUTES` after the `deleteLink` entry:
```ts
  [
    'PUT /api/ui/environments/:id/backend',
    (h, i) => putBackend(testEvent({ headers: h, params: { id: i.envId }, body: { backend: null } })),
    OWN
  ],
```

- [ ] **Step 8: Run, expect PASS**

Run: `pnpm vitest run tests/integration/backend-settings.test.ts tests/integration/route-roles.test.ts tests/unit/roles.test.ts tests/unit/project-can.test.ts`
Expected: PASS. If a unit test enumerates every permission, add `environment:configure` with `owner` there.

- [ ] **Step 9: Commit**

```bash
git add server/db/schema.ts drizzle/ server/services/variables.ts server/utils/project-access.ts shared/project-permissions.ts 'server/api/ui/environments/[id]/backend.put.ts' tests/integration/backend-settings.test.ts tests/integration/route-roles.test.ts
git commit -m "feat: per-environment backend settings, editable by owners"
```

---

### Task 4: `GET /api/checkout/:org/:project/:environment`

**Files:**
- Create: `server/api/checkout/[org]/[project]/[environment].get.ts`, `tests/protocol/checkout.test.ts`

**Interfaces:**
- Consumes: `readBackend` (Task 3), `readDeliveryValues`, `findEnvironment`, `authenticateTf`, `authorizeVars`, `requireCreatorAccess`, `resolveProject`
- Produces: response `{ variables: Record<string, JsonValue>; backend: BackendSettings | null }`, shared type `CheckoutResponse` in `shared/schemas/backend.ts`

- [ ] **Step 1: Write the failing protocol test**

`tests/protocol/checkout.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { eq } from 'drizzle-orm'
import { auth } from '../../server/utils/auth'
import { db } from '../../server/db/client'
import { auditLog } from '../../server/db/schema'
import { createEnvironment, setBackend, setVariable } from '../../server/services/variables'
import { resetDb, seedProject, provisionUser } from './helpers'

await setup({ server: true })

const ORG = 'checkout'
const tokens: Record<string, string> = {}
const get = (path: string, token?: string) =>
  fetch(absoluteUrl(path), {
    headers: token
      ? { authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` }
      : {}
  })

beforeAll(async () => {
  await resetDb(ORG)
  const projectId = await seedProject(ORG, 'prod')
  await seedProject(ORG, 'other')
  const user = await provisionUser(`checkout-${Date.now()}@example.com`, 'correct horse battery', 'admin')
  const client = await createEnvironment(projectId, 'client')
  await createEnvironment(projectId, 'internal')
  await setVariable({
    environmentId: client.id,
    name: 'db_password',
    input: { value: 'hunter2', sensitive: true },
    userId: user.id
  })
  await setBackend(client.id, { bucket: 'b', encrypt: true })
  const make = async (name: string, permissions: Record<string, string[]>, projects: string[]) =>
    (
      await auth.api.createApiKey({
        body: { userId: user.id, name, permissions, metadata: { scope: { kind: 'projects', projects } } }
      })
    ).key
  tokens.vars = await make('vars', { state: [], vars: ['read'] }, [`${ORG}/prod`])
  tokens.stateOnly = await make('state', { state: ['read'] }, [`${ORG}/prod`])
  tokens.elsewhere = await make('elsewhere', { state: [], vars: ['read'] }, [`${ORG}/other`])
})

const path = `/api/checkout/${ORG}/prod/client`

describe('GET /api/checkout/:org/:project/:environment', () => {
  it('answers 401 without credentials', async () => {
    expect((await get(path)).status).toBe(401)
  })
  it('answers 404 for an unknown project', async () => {
    expect((await get(`/api/checkout/${ORG}/nope/client`, tokens.vars)).status).toBe(404)
  })
  it('answers 404 for an unknown environment', async () => {
    expect((await get(`/api/checkout/${ORG}/prod/staging`, tokens.vars)).status).toBe(404)
  })
  it('answers 403 to a state-only token, even for an unknown environment', async () => {
    expect((await get(path, tokens.stateOnly)).status).toBe(403)
    expect((await get(`/api/checkout/${ORG}/prod/staging`, tokens.stateOnly)).status).toBe(403)
  })
  it('answers 403 to a token scoped to another project', async () => {
    expect((await get(path, tokens.elsewhere)).status).toBe(403)
  })
  it('returns variables and backend settings, uncached, with one audit row', async () => {
    const before = (await db().select().from(auditLog).where(eq(auditLog.action, 'checkout.read'))).length
    const response = await get(path, tokens.vars)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      variables: { db_password: 'hunter2' },
      backend: { bucket: 'b', encrypt: true }
    })
    const rows = await db().select().from(auditLog).where(eq(auditLog.action, 'checkout.read'))
    expect(rows.length).toBe(before + 1)
    expect(rows.at(-1)?.metaJson).toEqual({ environment: 'client', count: 1 })
  })
  it('returns backend null for an environment without settings', async () => {
    const response = await get(`/api/checkout/${ORG}/prod/internal`, tokens.vars)
    expect(await response.json()).toEqual({ variables: {}, backend: null })
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm vitest run tests/protocol/checkout.test.ts`
Expected: FAIL with 404 on the 200 case (route does not exist).

- [ ] **Step 3: Add the shared response type**

Append to `shared/schemas/backend.ts`:
```ts
import type { JsonValue } from './variable'

/** Body of GET /api/checkout/:org/:project/:environment (checkout spec §4). */
export type CheckoutResponse = {
  variables: Record<string, JsonValue>
  backend: BackendSettings | null
}
```
(Put the `import type` at the top of the file with the other import.)

- [ ] **Step 4: Implement the route**

`server/api/checkout/[org]/[project]/[environment].get.ts`:
```ts
import { authenticateTf, authorizeVars, requireCreatorAccess } from '../../../../utils/tf-auth'
import { resolveProject } from '../../../../utils/tf-handler'
import { findEnvironment, readBackend, readDeliveryValues } from '../../../../services/variables'
import { recordAuditBestEffort } from '../../../../services/audit'
import { environmentRefSchema } from '../../../../../shared/schemas/project'
import type { CheckoutResponse } from '../../../../../shared/schemas/backend'

/**
 * What `statesman pull` needs for one environment (checkout spec §4): the
 * variables /api/vars delivers plus the backend settings. Same door, same
 * order of checks, no new token permission.
 */
export default defineEventHandler(async (event): Promise<CheckoutResponse> => {
  const principal = await authenticateTf(event)

  let params: { org: string; project: string; environment: string }
  try {
    params = await getValidatedRouterParams(event, environmentRefSchema.parse)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Unknown environment' })
  }
  const ref = { org: params.org, project: params.project }
  const resolved = await resolveProject(ref)
  authorizeVars(principal, ref)
  await requireCreatorAccess(principal, resolved, 'vars:read')
  const found = await findEnvironment(resolved.id, params.environment)
  if (!found) throw createError({ statusCode: 404, statusMessage: 'Unknown environment' })

  const [variables, backend] = await Promise.all([
    readDeliveryValues(found.id),
    readBackend(found.id)
  ])
  setResponseHeader(event, 'cache-control', 'no-store')
  await recordAuditBestEffort({
    orgId: resolved.orgId,
    projectId: resolved.id,
    actorType: 'api-key',
    actorId: principal.keyId,
    action: 'checkout.read',
    meta: { environment: params.environment, count: Object.keys(variables).length }
  })
  return { variables, backend }
})
```

- [ ] **Step 5: Run, expect PASS**

Run: `pnpm vitest run tests/protocol/checkout.test.ts tests/protocol/vars-delivery.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add 'server/api/checkout' shared/schemas/backend.ts tests/protocol/checkout.test.ts
git commit -m "feat: checkout endpoint returning an environment's variables and backend settings"
```

---

### Task 5: Manifest schema

**Files:**
- Create: `shared/schemas/manifest.ts`, `tests/unit/manifest-schema.test.ts`

**Interfaces:**
- Consumes: `projectSlug` from `shared/schemas/project.ts`
- Produces:
  - `manifestSchema`; `type Manifest = { server: string; project: string; environments: string[]; files: { vars: string; backend?: string; env?: string } }`
  - `type FileKind = 'vars' | 'backend' | 'env'`
  - `fileFor(pattern: string, env: string): string`
  - `parseManifest(text: string): Manifest` — throws `Error` whose message starts `statesman.json: `

- [ ] **Step 1: Write the failing tests**

`tests/unit/manifest-schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { fileFor, parseManifest } from '../../shared/schemas/manifest'

const base = {
  server: 'https://statesman.example.com',
  project: 'acme/sbf-ai',
  environments: ['internal', 'client'],
  files: { vars: '{env}.tfvars', backend: 'backend.{env}.hcl', env: '.env.{env}' }
}
const text = (patch: object) => JSON.stringify({ ...base, ...patch })
const error = (patch: object) => {
  try {
    parseManifest(text(patch))
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected a refusal')
}

describe('parseManifest', () => {
  it('accepts the documented two-environment manifest', () => {
    expect(parseManifest(text({})).environments).toEqual(['internal', 'client'])
  })

  it('accepts terraform.tfvars with a single environment', () => {
    const m = parseManifest(text({ environments: ['prod'], files: { vars: 'terraform.tfvars' } }))
    expect(m.files.vars).toBe('terraform.tfvars')
  })

  it.each(['terraform.tfvars', 'terraform.tfvars.json', '{env}.auto.tfvars', '{env}.auto.tfvars.json'])(
    'refuses auto-loaded vars name %s with two environments',
    (vars) => {
      expect(error({ files: { vars } })).toMatch(/^statesman\.json: files\.vars: .*loaded by Terraform for every environment/)
    }
  )

  it('refuses a pattern without {env} when there are two environments', () => {
    expect(error({ files: { vars: '{env}.tfvars', backend: 'backend.hcl' } })).toContain('files.backend')
  })

  it.each(['../x.tfvars', 'dir/{env}.tfvars', '{env} vars.tfvars', '.', '..'])(
    'refuses unsafe file name %s',
    (vars) => {
      expect(error({ files: { vars } })).toContain('files.vars')
    }
  )

  it('refuses a vars name that is not .tfvars or .tfvars.json', () => {
    expect(error({ files: { vars: '{env}.vars' } })).toContain('files.vars')
  })

  it('refuses duplicate environments, bad slugs, a bad project, unknown fields', () => {
    expect(error({ environments: ['a', 'a'] })).toContain('environments')
    expect(error({ environments: ['Bad_Slug'] })).toContain('environments')
    expect(error({ environments: [] })).toContain('environments')
    expect(error({ project: 'no-slash' })).toContain('project')
    expect(error({ extra: true })).toContain('statesman.json')
  })

  it('refuses a non-http server', () => {
    expect(error({ server: 'ftp://x' })).toContain('server')
  })

  it('reports invalid JSON', () => {
    expect(() => parseManifest('{')).toThrow(/^statesman\.json: not valid JSON/)
  })
})

describe('fileFor', () => {
  it('substitutes every {env}', () => {
    expect(fileFor('{env}/{env}.tfvars', 'client')).toBe('client/client.tfvars')
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm vitest run tests/unit/manifest-schema.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`shared/schemas/manifest.ts`:
```ts
import { z } from 'zod'
import { projectSlug } from './project'

export type FileKind = 'vars' | 'backend' | 'env'

// Shell-safe on purpose: the .env file is sourced with `. ./.env.<env>`, and
// these names end up unquoted in TF_CLI_ARGS_* (checkout spec §5).
const fileName = z
  .string()
  .regex(/^[A-Za-z0-9._{}-]+$/, 'must be a file name in this directory: letters, digits, . _ - and {env}')
  .refine((n) => n !== '.' && n !== '..', 'must be a file name in this directory')

const AUTO_LOADED = /^(terraform\.tfvars(\.json)?|.*\.auto\.tfvars(\.json)?)$/

export const manifestSchema = z
  .object({
    server: z.url({ protocol: /^https?$/ }),
    project: z
      .string()
      .refine((p) => {
        const parts = p.split('/')
        return parts.length === 2 && parts.every((s) => projectSlug.safeParse(s).success)
      }, 'must be org/project'),
    environments: z
      .array(projectSlug)
      .min(1)
      .refine((e) => new Set(e).size === e.length, 'must not repeat an environment'),
    files: z
      .object({
        vars: fileName.refine(
          (n) => n.endsWith('.tfvars') || n.endsWith('.tfvars.json'),
          'must end in .tfvars or .tfvars.json'
        ),
        backend: fileName.optional(),
        env: fileName.optional()
      })
      .strict()
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.environments.length < 2) return
    for (const kind of ['vars', 'backend', 'env'] as const) {
      const pattern = m.files[kind]
      if (pattern !== undefined && !pattern.includes('{env}')) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', kind],
          message: `"${pattern}" has no {env}, so every environment would write the same file`
        })
      }
    }
    if (AUTO_LOADED.test(m.files.vars)) {
      ctx.addIssue({
        code: 'custom',
        path: ['files', 'vars'],
        message: `"${m.files.vars}" is loaded by Terraform for every environment, so one environment's values would leak into another's runs`
      })
    }
  })

export type Manifest = z.infer<typeof manifestSchema>

export function fileFor(pattern: string, env: string): string {
  return pattern.replaceAll('{env}', env)
}

export function parseManifest(text: string): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('statesman.json: not valid JSON')
  }
  const result = manifestSchema.safeParse(raw)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
  throw new Error(`statesman.json: ${where}${issue?.message ?? 'invalid'}`)
}
```
`issue.path` for `environments` element errors is `environments.0`, which contains `environments`, as the test expects.

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm vitest run tests/unit/manifest-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/schemas/manifest.ts tests/unit/manifest-schema.test.ts
git commit -m "feat: statesman.json manifest schema"
```

---

### Task 6: CLI pure modules (render, `.env` merge, compare, strays)

**Files:**
- Create: `cli/src/render.ts`, `cli/src/env-file.ts`, `cli/src/compare.ts`, `cli/src/strays.ts`
- Create: `tests/unit/cli-render.test.ts`, `tests/unit/cli-env-file.test.ts`, `tests/unit/cli-compare.test.ts`, `tests/unit/cli-strays.test.ts`

**Interfaces:**
- Consumes: `toTfvars` (Task 1), `Manifest`, `fileFor` (Task 5), `HclToolkit`, `HclError`
- Produces:
  - `renderVars(values: Record<string, JsonValue>, fileName: string): string`
  - `renderBackend(backend: BackendSettings): string`
  - `ownedEntries(files: { vars: string; backend?: string }, env: string): Array<[string, string]>`
  - `mergeEnvFile(existing: string | null, owned: Array<[string, string]>): string`
  - `envFileDiffers(existing: string, owned: Array<[string, string]>): string[]` (names of differing owned keys)
  - `type MapDiff = { onlyInStatesman: string[]; onlyLocal: string[]; changed: string[] }`
  - `diffMaps(expected: Record<string, unknown>, actual: Record<string, unknown>): MapDiff`
  - `isEmptyDiff(d: MapDiff): boolean`
  - `describeDiff(d: MapDiff): string[]` (names, prefixed `+`/`-` for one-sided)
  - `parseLocal(text: string, fileName: string, hcl: HclToolkit): Record<string, JsonValue>` (throws `LocalParseError` with `.message` = `<file>:<line>: <reason>` or `<file>: <reason>`)
  - `findStrays(entries: string[], tracked: Set<string>, manifest: Manifest): Array<{ file: string; env: string }>`

- [ ] **Step 1: Write failing tests for render**

`tests/unit/cli-render.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { renderBackend, renderVars } from '../../cli/src/render'

describe('renderVars', () => {
  it('writes HCL for .tfvars', () => {
    expect(renderVars({ b: 1, a: 'x' }, 'client.tfvars')).toBe('a = "x"\nb = 1\n')
  })
  it('writes sorted, indented JSON with a newline for .tfvars.json', () => {
    expect(renderVars({ b: 1, a: 'x' }, 'client.tfvars.json')).toBe('{\n  "a": "x",\n  "b": 1\n}\n')
  })
})

describe('renderBackend', () => {
  it('writes a flat HCL file', () => {
    expect(renderBackend({ region: 'r', bucket: 'b', encrypt: true })).toBe(
      'bucket = "b"\nencrypt = true\nregion = "r"\n'
    )
  })
})
```
Before writing the expected strings, check whether `toTfvars` sorts keys or keeps insertion order (`shared/hcl/tfvars.ts`). If it keeps order, `render.ts` sorts first (below), so the expectations hold either way.

- [ ] **Step 2: Write failing tests for the `.env` file**

`tests/unit/cli-env-file.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { envFileDiffers, mergeEnvFile, ownedEntries } from '../../cli/src/env-file'

const files = { vars: 'client.tfvars', backend: 'backend.client.hcl' }
const owned = ownedEntries(files, 'client')

describe('ownedEntries', () => {
  it('lists TF_DATA_DIR, init and each var-file command in order', () => {
    expect(owned.map(([k]) => k)).toEqual([
      'TF_DATA_DIR',
      'TF_CLI_ARGS_init',
      'TF_CLI_ARGS_plan',
      'TF_CLI_ARGS_apply',
      'TF_CLI_ARGS_destroy',
      'TF_CLI_ARGS_import',
      'TF_CLI_ARGS_refresh',
      'TF_CLI_ARGS_console'
    ])
    expect(Object.fromEntries(owned)).toMatchObject({
      TF_DATA_DIR: '.terraform-client',
      TF_CLI_ARGS_init: '-backend-config=backend.client.hcl',
      TF_CLI_ARGS_plan: '-var-file=client.tfvars'
    })
  })
  it('leaves out init when there is no backend file', () => {
    expect(ownedEntries({ vars: 'client.tfvars' }, 'client').map(([k]) => k)).not.toContain('TF_CLI_ARGS_init')
  })
})

describe('mergeEnvFile', () => {
  it('starts a new file with a header comment and every owned key', () => {
    const out = mergeEnvFile(null, owned)
    expect(out.split('\n')[0]).toMatch(/^# /)
    expect(out).toContain('TF_DATA_DIR=.terraform-client\n')
    expect(out.endsWith('\n')).toBe(true)
  })

  it('keeps foreign lines in place and updates owned keys where they stand', () => {
    const existing = '# mine\nAWS_PROFILE=client\nTF_DATA_DIR=.terraform\nAWS_REGION=ap-southeast-1\n'
    const out = mergeEnvFile(existing, owned).split('\n')
    expect(out.slice(0, 4)).toEqual([
      '# mine',
      'AWS_PROFILE=client',
      'TF_DATA_DIR=.terraform-client',
      'AWS_REGION=ap-southeast-1'
    ])
    expect(out.filter((l) => l.startsWith('TF_DATA_DIR')).length).toBe(1)
    expect(out).toContain('TF_CLI_ARGS_console=-var-file=client.tfvars')
  })

  it('keeps an export prefix and replaces a quoted owned value', () => {
    const out = mergeEnvFile('export TF_DATA_DIR=".old"\n', owned)
    expect(out).toContain('export TF_DATA_DIR=.terraform-client\n')
    expect(out).not.toContain('.old')
  })

  it('removes TF_CLI_ARGS_init when the backend file goes away', () => {
    const withInit = mergeEnvFile(null, owned)
    const without = mergeEnvFile(withInit, ownedEntries({ vars: 'client.tfvars' }, 'client'))
    expect(without).not.toContain('TF_CLI_ARGS_init')
  })

  it('preserves CRLF line endings', () => {
    const out = mergeEnvFile('AWS_PROFILE=x\r\nTF_DATA_DIR=old\r\n', owned)
    expect(out).toContain('AWS_PROFILE=x\r\nTF_DATA_DIR=.terraform-client\r\n')
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('envFileDiffers', () => {
  it('is empty for a merged file with foreign lines', () => {
    expect(envFileDiffers(mergeEnvFile('AWS_PROFILE=x\n', owned), owned)).toEqual([])
  })
  it('names a missing, changed or no-longer-owned key', () => {
    expect(envFileDiffers('TF_DATA_DIR=.terraform\n', owned)).toEqual(
      expect.arrayContaining(['TF_DATA_DIR', 'TF_CLI_ARGS_plan'])
    )
    const stale = mergeEnvFile(null, owned)
    expect(envFileDiffers(stale, ownedEntries({ vars: 'client.tfvars' }, 'client'))).toEqual([
      'TF_CLI_ARGS_init'
    ])
  })
})
```

- [ ] **Step 3: Write failing tests for compare**

`tests/unit/cli-compare.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHclToolkit, type HclToolkit } from '../../server/hcl/toolkit'
import { describeDiff, diffMaps, isEmptyDiff, LocalParseError, parseLocal } from '../../cli/src/compare'

let hcl: HclToolkit
beforeAll(async () => {
  hcl = await createHclToolkit(async (name) => readFileSync(join('server/assets/wasm', name)))
})

describe('parseLocal', () => {
  it('reads a hand-formatted .tfvars file the same as rendered output', () => {
    const hand = '# comment\nregion="r"\n\n  count   =   3\ntags = {\n  b = 2\n  a = 1\n}\n'
    expect(parseLocal(hand, 'x.tfvars', hcl)).toEqual({ region: 'r', count: 3, tags: { a: 1, b: 2 } })
  })
  it('reads .tfvars.json', () => {
    expect(parseLocal('{"a":1}', 'x.tfvars.json', hcl)).toEqual({ a: 1 })
  })
  it('reports an expression with its file and line, never the value', () => {
    try {
      parseLocal('a = "secret-value"\nb = var.x\n', 'client.tfvars', hcl)
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(LocalParseError)
      expect((e as Error).message).toMatch(/^client\.tfvars:2: /)
      expect((e as Error).message).not.toContain('secret-value')
    }
  })
  it('reports JSON that is not an object', () => {
    expect(() => parseLocal('[1]', 'x.tfvars.json', hcl)).toThrow(LocalParseError)
    expect(() => parseLocal('{', 'x.tfvars.json', hcl)).toThrow(/^x\.tfvars\.json: /)
  })
})

describe('diffMaps', () => {
  it('matches deeply equal maps regardless of key order', () => {
    expect(isEmptyDiff(diffMaps({ a: { x: 1, y: [1, 2] } }, { a: { y: [1, 2], x: 1 } }))).toBe(true)
  })
  it('names each kind of difference, sorted, without values', () => {
    const d = diffMaps({ a: 1, b: 'new', c: 3 }, { b: 'old', c: 3, z: 9 })
    expect(d).toEqual({ onlyInStatesman: ['a'], onlyLocal: ['z'], changed: ['b'] })
    const text = describeDiff(d).join(' ')
    expect(text).toBe('b +a -z')
    expect(text).not.toContain('new')
    expect(text).not.toContain('old')
  })
  it('treats 1 and "1" as different', () => {
    expect(diffMaps({ a: 1 }, { a: '1' }).changed).toEqual(['a'])
  })
})
```
`describeDiff` order: changed names, then `+name` for only-in-statesman, then `-name` for only-local.

- [ ] **Step 4: Write failing tests for strays**

`tests/unit/cli-strays.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { findStrays } from '../../cli/src/strays'
import type { Manifest } from '../../shared/schemas/manifest'

const manifest: Manifest = {
  server: 'https://s.example.com',
  project: 'acme/p',
  environments: ['internal', 'client'],
  files: { vars: '{env}.tfvars', backend: 'backend.{env}.hcl', env: '.env.{env}' }
}

describe('findStrays', () => {
  it('reports a file matching a pattern for an unlisted environment', () => {
    const entries = ['client.tfvars', '.env.staging', 'backend.old.hcl', 'main.tf']
    expect(findStrays(entries, new Set(), manifest)).toEqual([
      { file: '.env.staging', env: 'staging' },
      { file: 'backend.old.hcl', env: 'old' }
    ])
  })
  it('never reports a git-tracked file such as .env.example', () => {
    expect(findStrays(['.env.example'], new Set(['.env.example']), manifest)).toEqual([])
  })
  it('ignores names whose {env} part is not a valid slug', () => {
    expect(findStrays(['backend.hcl.example', 'x.y.tfvars', '.terraform.lock.hcl'], new Set(), manifest)).toEqual([])
  })
  it('reports nothing for a pattern without {env}', () => {
    const single: Manifest = { ...manifest, environments: ['prod'], files: { vars: 'terraform.tfvars' } }
    expect(findStrays(['terraform.tfvars', 'other.tfvars'], new Set(), single)).toEqual([])
  })
})
```
`backend.hcl.example` does not match `backend.{env}.hcl` (it does not end in `.hcl`), and `x.y.tfvars` has a dot in the slug position, so neither is a stray.

- [ ] **Step 5: Run all four, expect FAIL**

Run: `pnpm vitest run tests/unit/cli-*.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 6: Implement `render.ts`**

`cli/src/render.ts`:
```ts
import { toTfvars } from '../../shared/hcl/tfvars'
import type { JsonValue } from '../../shared/schemas/variable'
import type { BackendSettings } from '../../shared/schemas/backend'

function sorted<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function renderVars(values: Record<string, JsonValue>, fileName: string): string {
  const ordered = sorted(values)
  if (fileName.endsWith('.tfvars.json')) return JSON.stringify(ordered, null, 2) + '\n'
  return toTfvars(ordered)
}

export function renderBackend(backend: BackendSettings): string {
  return toTfvars(sorted(backend))
}
```

- [ ] **Step 7: Implement `env-file.ts`**

`cli/src/env-file.ts`:
```ts
const VAR_FILE_COMMANDS = ['plan', 'apply', 'destroy', 'import', 'refresh', 'console'] as const

/** Every key the CLI may write. A key here but not in this run's list is removed. */
const ALL_OWNED = [
  'TF_DATA_DIR',
  'TF_CLI_ARGS_init',
  ...VAR_FILE_COMMANDS.map((c) => `TF_CLI_ARGS_${c}`)
]

const HEADER =
  '# TF_DATA_DIR and TF_CLI_ARGS_* are written by `statesman pull`. Other lines are yours and are kept.'

const LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

export function ownedEntries(
  files: { vars: string; backend?: string },
  env: string
): Array<[string, string]> {
  const entries: Array<[string, string]> = [['TF_DATA_DIR', `.terraform-${env}`]]
  if (files.backend) entries.push(['TF_CLI_ARGS_init', `-backend-config=${files.backend}`])
  for (const c of VAR_FILE_COMMANDS) entries.push([`TF_CLI_ARGS_${c}`, `-var-file=${files.vars}`])
  return entries
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1)
  return v
}

export function mergeEnvFile(existing: string | null, owned: Array<[string, string]>): string {
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n'
  const wanted = new Map(owned)
  const written = new Set<string>()
  const lines = existing === null ? [HEADER] : existing.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const out: string[] = []
  for (const line of lines) {
    const m = LINE.exec(line)
    const key = m?.[2]
    if (!m || key === undefined || !ALL_OWNED.includes(key)) {
      out.push(line)
      continue
    }
    const value = wanted.get(key)
    if (value === undefined || written.has(key)) continue // no longer owned here, or a duplicate
    out.push(`${m[1] ?? ''}${key}=${value}`)
    written.add(key)
  }
  for (const [key, value] of owned) if (!written.has(key)) out.push(`${key}=${value}`)
  return out.join(eol) + eol
}

export function envFileDiffers(existing: string, owned: Array<[string, string]>): string[] {
  const found = new Map<string, string>()
  for (const line of existing.split(/\r?\n/)) {
    const m = LINE.exec(line)
    if (m?.[2] && ALL_OWNED.includes(m[2])) found.set(m[2], unquote(m[3] ?? ''))
  }
  const wanted = new Map(owned)
  const differing = owned.filter(([k, v]) => found.get(k) !== v).map(([k]) => k)
  const extra = [...found.keys()].filter((k) => !wanted.has(k))
  return [...differing, ...extra]
}
```

- [ ] **Step 8: Implement `compare.ts`**

`cli/src/compare.ts`:
```ts
import { isDeepStrictEqual } from 'node:util'
import { HclError, type HclToolkit } from '../../server/hcl/toolkit'
import type { JsonValue } from '../../shared/schemas/variable'

export class LocalParseError extends Error {
  override name = 'LocalParseError'
}

export type MapDiff = { onlyInStatesman: string[]; onlyLocal: string[]; changed: string[] }

/** Throws LocalParseError. Messages carry a file and line, never a value. */
export function parseLocal(
  text: string,
  fileName: string,
  hcl: HclToolkit
): Record<string, JsonValue> {
  if (fileName.endsWith('.json')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new LocalParseError(`${fileName}: not valid JSON`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LocalParseError(`${fileName}: must be a JSON object`)
    }
    return parsed as Record<string, JsonValue>
  }
  try {
    return hcl.parseTfvars(text)
  } catch (error) {
    if (error instanceof HclError) {
      // HclError's own message is "<file>:<line>: <reason>" with the toolkit's
      // placeholder file name; restate it with ours.
      const reason = error.message.slice(error.message.indexOf(': ', error.message.indexOf(':') + 1) + 2)
      throw new LocalParseError(`${fileName}:${error.line}: ${reason}`)
    }
    throw error
  }
}

export function diffMaps(expected: Record<string, unknown>, actual: Record<string, unknown>): MapDiff {
  const names = (o: Record<string, unknown>) => Object.keys(o)
  const onlyInStatesman = names(expected).filter((k) => !(k in actual)).sort()
  const onlyLocal = names(actual).filter((k) => !(k in expected)).sort()
  const changed = names(expected)
    .filter((k) => k in actual && !isDeepStrictEqual(expected[k], actual[k]))
    .sort()
  return { onlyInStatesman, onlyLocal, changed }
}

export function isEmptyDiff(d: MapDiff): boolean {
  return d.onlyInStatesman.length === 0 && d.onlyLocal.length === 0 && d.changed.length === 0
}

export function describeDiff(d: MapDiff): string[] {
  return [...d.changed, ...d.onlyInStatesman.map((n) => `+${n}`), ...d.onlyLocal.map((n) => `-${n}`)]
}
```
Before relying on the `reason` slice, read `HclError` in `server/hcl/toolkit.ts`: its message is `${file}:${line}: ${message}`. If the toolkit exposes the bare message more directly, use that instead and drop the slicing. The test pins the output format and that no value leaks; confirm that `parseTfvars` error messages never quote a value (they quote the expression kind and line). If one does, replace the reason with a fixed phrase for that error kind.

- [ ] **Step 9: Implement `strays.ts`**

`cli/src/strays.ts`:
```ts
import type { Manifest } from '../../shared/schemas/manifest'

const SLUG = '[a-z0-9][a-z0-9-]*'
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function matcher(pattern: string): RegExp | null {
  if (!pattern.includes('{env}')) return null
  const source = pattern.split('{env}').map(escape).join(`(${SLUG})`)
  return new RegExp(`^${source}$`)
}

/** Files that look like a checkout for an environment the manifest does not list. */
export function findStrays(
  entries: string[],
  tracked: Set<string>,
  manifest: Manifest
): Array<{ file: string; env: string }> {
  const listed = new Set(manifest.environments)
  const matchers = [manifest.files.vars, manifest.files.backend, manifest.files.env]
    .filter((p): p is string => p !== undefined)
    .map(matcher)
    .filter((m): m is RegExp => m !== null)
  const strays: Array<{ file: string; env: string }> = []
  for (const file of [...entries].sort()) {
    if (tracked.has(file)) continue
    for (const m of matchers) {
      const env = m.exec(file)?.[1]
      if (env !== undefined && !listed.has(env)) {
        strays.push({ file, env })
        break
      }
    }
  }
  return strays
}
```

- [ ] **Step 10: Run, expect PASS**

Run: `pnpm vitest run tests/unit/cli-*.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add cli/src/render.ts cli/src/env-file.ts cli/src/compare.ts cli/src/strays.ts tests/unit/cli-render.test.ts tests/unit/cli-env-file.test.ts tests/unit/cli-compare.test.ts tests/unit/cli-strays.test.ts
git commit -m "feat(cli): render, .env merge, name-only comparison and stray detection"
```

---

### Task 7: CLI report core

**Files:**
- Create: `cli/src/errors.ts`, `cli/src/report.ts`, `tests/unit/cli-report.test.ts`

**Interfaces:**
- Consumes: Task 6 modules, `CheckoutResponse` (Task 4), `Manifest`, `fileFor`, `FileKind` (Task 5)
- Produces:
  - `class CliError extends Error { constructor(message: string, readonly exitCode: 1 | 2) }`
  - `type FileState = 'ok' | 'missing' | 'differs' | 'unreadable' | 'stray' | 'no-backend'`
  - `type FileReport = { env: string | null; file: string; kind: FileKind | null; state: FileState; detail: string[]; desired: string | null }`
  - `reportEnvironment(args: { manifest: Manifest; env: string; checkout: CheckoutResponse; read: (file: string) => string | null; hcl: HclToolkit }): FileReport[]`
  - `isDrift(r: FileReport): boolean` (true for missing, differs, unreadable, stray)

- [ ] **Step 1: Write the failing test**

`tests/unit/cli-report.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHclToolkit, type HclToolkit } from '../../server/hcl/toolkit'
import { isDrift, reportEnvironment } from '../../cli/src/report'
import { mergeEnvFile, ownedEntries } from '../../cli/src/env-file'
import type { Manifest } from '../../shared/schemas/manifest'

let hcl: HclToolkit
beforeAll(async () => {
  hcl = await createHclToolkit(async (name) => readFileSync(join('server/assets/wasm', name)))
})

const manifest: Manifest = {
  server: 'https://s.example.com',
  project: 'acme/p',
  environments: ['client'],
  files: { vars: '{env}.tfvars', backend: 'backend.{env}.hcl', env: '.env.{env}' }
}
const checkout = { variables: { a: 1, secret: 'shh' }, backend: { bucket: 'b' } }
const run = (files: Record<string, string>, c = checkout) =>
  reportEnvironment({ manifest, env: 'client', checkout: c, read: (f) => files[f] ?? null, hcl })

describe('reportEnvironment', () => {
  it('reports all three files missing in an empty directory, with desired contents', () => {
    const r = run({})
    expect(r.map((x) => [x.file, x.state])).toEqual([
      ['client.tfvars', 'missing'],
      ['backend.client.hcl', 'missing'],
      ['.env.client', 'missing']
    ])
    expect(r[0]?.desired).toBe('a = 1\nsecret = "shh"\n')
    expect(r.every(isDrift)).toBe(true)
  })

  it('reports ok for equivalent hand-formatted files', () => {
    const r = run({
      'client.tfvars': 'secret="shh"\na=1\n',
      'backend.client.hcl': 'bucket   = "b"\n',
      '.env.client': mergeEnvFile(
        'AWS_PROFILE=x\n',
        ownedEntries({ vars: 'client.tfvars', backend: 'backend.client.hcl' }, 'client')
      )
    })
    expect(r.map((x) => x.state)).toEqual(['ok', 'ok', 'ok'])
  })

  it('names differing variables without values', () => {
    const r = run({ 'client.tfvars': 'a = 2\nsecret = "shh"\nold = 1\n' })
    expect(r[0]).toMatchObject({ state: 'differs', detail: ['a', '-old'] })
    expect(JSON.stringify(r[0]?.detail)).not.toContain('shh')
  })

  it('reports an unparseable file as unreadable with its line', () => {
    const r = run({ 'client.tfvars': 'a = 1\nb = var.x\n' })
    expect(r[0]?.state).toBe('unreadable')
    expect(r[0]?.detail[0]).toMatch(/^client\.tfvars:2: /)
  })

  it('reports no-backend, not missing, when statesman has no backend settings', () => {
    const r = run({}, { variables: {}, backend: null })
    expect(r[1]).toMatchObject({ file: 'backend.client.hcl', state: 'no-backend', desired: null })
    expect(isDrift(r[1]!)).toBe(false)
    // and the .env file then has no TF_CLI_ARGS_init
    expect(r[2]?.desired).not.toContain('TF_CLI_ARGS_init')
  })
})
```
- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm vitest run tests/unit/cli-report.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`cli/src/errors.ts`:
```ts
/** An expected failure: printed without a stack, exits with its code. */
export class CliError extends Error {
  override name = 'CliError'
  constructor(
    message: string,
    readonly exitCode: 1 | 2
  ) {
    super(message)
  }
}
```

`cli/src/report.ts`:
```ts
import type { HclToolkit } from '../../server/hcl/toolkit'
import type { CheckoutResponse } from '../../shared/schemas/backend'
import { fileFor, type FileKind, type Manifest } from '../../shared/schemas/manifest'
import { renderBackend, renderVars } from './render'
import { envFileDiffers, mergeEnvFile, ownedEntries } from './env-file'
import { describeDiff, diffMaps, isEmptyDiff, LocalParseError, parseLocal } from './compare'

export type FileState = 'ok' | 'missing' | 'differs' | 'unreadable' | 'stray' | 'no-backend'

export type FileReport = {
  env: string | null
  file: string
  kind: FileKind | null
  state: FileState
  /** Variable or key names, or one unreadable message. Never values. */
  detail: string[]
  /** What pull would write; null when nothing should be written. */
  desired: string | null
}

const DRIFT: ReadonlySet<FileState> = new Set(['missing', 'differs', 'unreadable', 'stray'])
export const isDrift = (r: FileReport) => DRIFT.has(r.state)

function mapFile(
  env: string,
  kind: 'vars' | 'backend',
  file: string,
  expected: Record<string, unknown>,
  desired: string,
  local: string | null,
  hcl: HclToolkit
): FileReport {
  const base = { env, file, kind, desired }
  if (local === null) return { ...base, state: 'missing', detail: [] }
  try {
    const diff = diffMaps(expected, parseLocal(local, file, hcl))
    return isEmptyDiff(diff)
      ? { ...base, state: 'ok', detail: [] }
      : { ...base, state: 'differs', detail: describeDiff(diff) }
  } catch (error) {
    if (error instanceof LocalParseError) return { ...base, state: 'unreadable', detail: [error.message] }
    throw error
  }
}

export function reportEnvironment(args: {
  manifest: Manifest
  env: string
  checkout: CheckoutResponse
  read: (file: string) => string | null
  hcl: HclToolkit
}): FileReport[] {
  const { manifest, env, checkout, read, hcl } = args
  const varsFile = fileFor(manifest.files.vars, env)
  const reports: FileReport[] = [
    mapFile(env, 'vars', varsFile, checkout.variables, renderVars(checkout.variables, varsFile), read(varsFile), hcl)
  ]

  let backendFile: string | undefined
  if (manifest.files.backend) {
    const file = fileFor(manifest.files.backend, env)
    if (checkout.backend === null) {
      reports.push({ env, file, kind: 'backend', state: 'no-backend', detail: [], desired: null })
    } else {
      backendFile = file
      reports.push(mapFile(env, 'backend', file, checkout.backend, renderBackend(checkout.backend), read(file), hcl))
    }
  }

  if (manifest.files.env) {
    const file = fileFor(manifest.files.env, env)
    const owned = ownedEntries({ vars: varsFile, backend: backendFile }, env)
    const local = read(file)
    const desired = mergeEnvFile(local, owned)
    if (local === null) {
      reports.push({ env, file, kind: 'env', state: 'missing', detail: [], desired })
    } else {
      const differing = envFileDiffers(local, owned)
      reports.push({ env, file, kind: 'env', state: differing.length ? 'differs' : 'ok', detail: differing, desired })
    }
  }
  return reports
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm vitest run tests/unit/cli-report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/errors.ts cli/src/report.ts tests/unit/cli-report.test.ts
git commit -m "feat(cli): per-file reports for one environment"
```

---

### Task 8: CLI I/O, commands and entry point

**Files:**
- Create: `cli/src/client.ts`, `cli/src/git.ts`, `cli/src/files.ts`, `cli/src/wasm.ts`, `cli/src/commands.ts`, `cli/src/output.ts`, `cli/src/main.ts`
- Create: `tests/unit/cli-client.test.ts`, `tests/integration/cli-commands.test.ts`

**Interfaces:**
- Consumes: Tasks 5–7
- Produces:
  - `fetchCheckout(args: { server: string; project: string; env: string; token: string; fetchImpl?: typeof fetch }): Promise<CheckoutResponse>` — throws `CliError(…, 2)`
  - `gitIgnored(dir: string, file: string): Promise<boolean | null>` (null: not a git repo)
  - `gitTracked(dir: string): Promise<Set<string>>` (empty outside git)
  - `readOrNull(path: string): string | null`; `writeAtomic(path: string, content: string, mode: number): void`
  - `loadHcl(): Promise<HclToolkit>`
  - `type RunOptions = { dir: string; envs: string[]; token: string | undefined; serverOverride: string | undefined; fetchImpl?: typeof fetch }`
  - `status(opts: RunOptions): Promise<CommandResult>`; `pull(opts: RunOptions & { force: boolean }): Promise<CommandResult>`
  - `type CommandResult = { reports: Array<FileReport & { action?: 'written' | 'refused' }>; exitCode: 0 | 1 }`
  - `formatText(result: CommandResult): string`; `formatJson(result: CommandResult): string`
  - `main(argv: string[], env: NodeJS.ProcessEnv): Promise<number>`

- [ ] **Step 1: Write failing client tests (fake fetch)**

`tests/unit/cli-client.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { fetchCheckout } from '../../cli/src/client'
import { CliError } from '../../cli/src/errors'

const respond = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
const args = { server: 'https://s.example.com', project: 'acme/p', env: 'client', token: 't' }

async function failure(fetchImpl: typeof fetch): Promise<CliError> {
  try {
    await fetchCheckout({ ...args, fetchImpl })
  } catch (e) {
    if (e instanceof CliError) return e
    throw e
  }
  throw new Error('expected a CliError')
}

describe('fetchCheckout', () => {
  it('sends Basic auth to the checkout path and returns the body', async () => {
    let seen: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input, init)
      return new Response(JSON.stringify({ variables: { a: 1 }, backend: null }))
    }) as typeof fetch
    expect(await fetchCheckout({ ...args, fetchImpl })).toEqual({ variables: { a: 1 }, backend: null })
    expect(seen?.url).toBe('https://s.example.com/api/checkout/acme/p/client')
    expect(seen?.headers.get('authorization')).toBe(`Basic ${Buffer.from('statesman:t').toString('base64')}`)
  })

  it.each([
    [401, /rejected STATESMAN_TOKEN/],
    [403, /cannot read variables of acme\/p/],
    [404, /environment "client" does not exist in acme\/p.*Variables tab/],
    [500, /statesman answered 500/]
  ])('maps %i to an exit-2 error with the fix', async (status, message) => {
    const e = await failure(respond(status))
    expect(e.exitCode).toBe(2)
    expect(e.message).toMatch(message)
  })

  it('maps a network failure to exit 2 naming the server', async () => {
    const e = await failure((async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    expect(e.exitCode).toBe(2)
    expect(e.message).toContain('https://s.example.com')
  })

  it('refuses a body that is not a checkout response', async () => {
    expect((await failure(respond(200, { nope: true }))).exitCode).toBe(2)
  })
})
```

- [ ] **Step 2: Write failing command tests (real temp dirs, real git, fake fetch)**

`tests/integration/cli-commands.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pull, status } from '../../cli/src/commands'
import { main } from '../../cli/src/main'

const MANIFEST = {
  server: 'https://s.example.com',
  project: 'acme/p',
  environments: ['internal', 'client'],
  files: { vars: '{env}.tfvars', backend: 'backend.{env}.hcl', env: '.env.{env}' }
}
const DATA: Record<string, unknown> = {
  internal: { variables: { a: 1 }, backend: { bucket: 'bi' } },
  client: { variables: { a: 2, secret: 'shh' }, backend: { bucket: 'bc' } }
}
const fakeFetch = (async (input: RequestInfo | URL) => {
  const env = String(input).split('/').at(-1) ?? ''
  return new Response(JSON.stringify(DATA[env]), { status: DATA[env] ? 200 : 404 })
}) as typeof fetch

let dir: string
const opts = (extra: object = {}) => ({
  dir,
  envs: [],
  token: 't',
  serverOverride: undefined,
  fetchImpl: fakeFetch,
  ...extra
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'statesman-cli-'))
  writeFileSync(join(dir, 'statesman.json'), JSON.stringify(MANIFEST))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('pull and status outside git', () => {
  it('pull writes six files, the vars files 0600; status is then clean', async () => {
    const result = await pull({ ...opts(), force: false })
    expect(result.exitCode).toBe(0)
    for (const f of ['internal.tfvars', 'client.tfvars', 'backend.client.hcl', '.env.client']) {
      expect(existsSync(join(dir, f))).toBe(true)
    }
    expect(statSync(join(dir, 'client.tfvars')).mode & 0o777).toBe(0o600)
    expect((await status(opts())).exitCode).toBe(0)
  })

  it('refuses to overwrite a changed vars file without --force, but writes the rest', async () => {
    writeFileSync(join(dir, 'client.tfvars'), 'a = 99\n')
    const result = await pull({ ...opts(), force: false })
    expect(result.exitCode).toBe(1)
    expect(result.reports.find((r) => r.file === 'client.tfvars')).toMatchObject({ action: 'refused', detail: ['a', '+secret'] })
    expect(readFileSync(join(dir, 'client.tfvars'), 'utf8')).toBe('a = 99\n')
    expect(existsSync(join(dir, 'internal.tfvars'))).toBe(true)
    const forced = await pull({ ...opts(), force: true })
    expect(forced.exitCode).toBe(0)
    expect(readFileSync(join(dir, 'client.tfvars'), 'utf8')).toContain('secret = "shh"')
  })

  it('always merges .env files and keeps foreign lines, without --force', async () => {
    writeFileSync(join(dir, '.env.client'), 'AWS_PROFILE=client\nTF_DATA_DIR=.terraform\n')
    const result = await pull({ ...opts(), force: false })
    expect(result.exitCode).toBe(0)
    const text = readFileSync(join(dir, '.env.client'), 'utf8')
    expect(text).toContain('AWS_PROFILE=client\nTF_DATA_DIR=.terraform-client\n')
  })

  it('--env limits the run and refuses an environment not in the manifest', async () => {
    const result = await pull({ ...opts({ envs: ['client'] }), force: false })
    expect(result.reports.every((r) => r.env === 'client' || r.env === null)).toBe(true)
    await expect(status(opts({ envs: ['staging'] }))).rejects.toMatchObject({ exitCode: 2 })
  })

  it('status reports a stray and exits 1', async () => {
    await pull({ ...opts(), force: false })
    writeFileSync(join(dir, '.env.staging'), 'X=1\n')
    const result = await status(opts())
    expect(result.exitCode).toBe(1)
    expect(result.reports.find((r) => r.state === 'stray')).toMatchObject({ file: '.env.staging', env: null })
  })
})

describe('inside git', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q'], { cwd: dir })
  })

  it('refuses before writing anything when a vars file would be committed', async () => {
    await expect(pull({ ...opts(), force: false })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('internal.tfvars') as unknown as string
    })
    expect(existsSync(join(dir, 'backend.client.hcl'))).toBe(false)
  })

  it('writes once the vars files are ignored, and a tracked .env.example is not stray', async () => {
    writeFileSync(join(dir, '.gitignore'), '*.tfvars\n')
    writeFileSync(join(dir, '.env.example'), 'X=1\n')
    execFileSync('git', ['add', '.env.example', '.gitignore'], { cwd: dir })
    expect((await pull({ ...opts(), force: false })).exitCode).toBe(0)
    expect((await status(opts())).reports.some((r) => r.state === 'stray')).toBe(false)
  })
})

describe('main', () => {
  it('exits 2 with the fix when STATESMAN_TOKEN is unset, writing nothing', async () => {
    const errors: string[] = []
    const original = console.error
    console.error = (m: string) => errors.push(m)
    try {
      expect(await main(['pull', '--dir', dir], {})).toBe(2)
    } finally {
      console.error = original
    }
    expect(errors.join('\n')).toContain('set STATESMAN_TOKEN')
    expect(existsSync(join(dir, 'client.tfvars'))).toBe(false)
  })

  it('exits 2 for a missing manifest and for an unknown command', async () => {
    rmSync(join(dir, 'statesman.json'))
    expect(await main(['status', '--dir', dir], { STATESMAN_TOKEN: 't' })).toBe(2)
    expect(await main(['frobnicate'], { STATESMAN_TOKEN: 't' })).toBe(2)
  })
})
```

- [ ] **Step 3: Run, expect FAIL**

Run: `pnpm vitest run tests/unit/cli-client.test.ts tests/integration/cli-commands.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `client.ts`**

```ts
import { z } from 'zod'
import { backendSettingsSchema, type CheckoutResponse } from '../../shared/schemas/backend'
import { CliError } from './errors'

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)])
)
const responseSchema = z.object({
  variables: z.record(z.string(), jsonValue),
  backend: backendSettingsSchema.nullable()
})

export async function fetchCheckout(args: {
  server: string
  project: string
  env: string
  token: string
  fetchImpl?: typeof fetch
}): Promise<CheckoutResponse> {
  const { server, project, env, token, fetchImpl = fetch } = args
  const url = new URL(`/api/checkout/${project}/${env}`, server).toString()
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` }
    })
  } catch {
    throw new CliError(`could not reach statesman at ${server}`, 2)
  }
  if (response.status === 401) throw new CliError('statesman rejected STATESMAN_TOKEN (expired, revoked or mistyped)', 2)
  if (response.status === 403) throw new CliError(`this token cannot read variables of ${project}`, 2)
  if (response.status === 404) {
    throw new CliError(`environment "${env}" does not exist in ${project}; create it on the Variables tab`, 2)
  }
  if (!response.ok) throw new CliError(`statesman answered ${response.status} for ${project}/${env}`, 2)
  const parsed = responseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new CliError(`statesman sent an unexpected response for ${project}/${env}`, 2)
  return parsed.data as CheckoutResponse
}
```
The final `as CheckoutResponse` narrows `unknown` JSON values to `JsonValue`; if `shared/schemas/variable.ts` exports a Zod schema for `JsonValue`, use it instead of `jsonValue` and drop the cast.

- [ ] **Step 5: Implement `git.ts`, `files.ts`, `wasm.ts`**

`cli/src/git.ts`:
```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** null when `dir` is not inside a git work tree. */
export async function gitIgnored(dir: string, file: string): Promise<boolean | null> {
  try {
    await run('git', ['check-ignore', '-q', file], { cwd: dir })
    return true
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 1) return false
    return null // 128: not a repository; ENOENT: no git installed
  }
}

export async function gitTracked(dir: string): Promise<Set<string>> {
  try {
    const { stdout } = await run('git', ['ls-files', '-z', '--', '.'], { cwd: dir })
    return new Set(stdout.split('\0').filter(Boolean))
  } catch {
    return new Set()
  }
}
```

`cli/src/files.ts`:
```ts
import { readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Temp file in the same directory, then rename: never a half-written file. */
export function writeAtomic(path: string, content: string, mode: number): void {
  const temp = join(dirname(path), `.${basename(path)}.statesman-${process.pid}`)
  try {
    writeFileSync(temp, content, { mode })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
```
`writeFileSync` with `mode` only applies on create; the temp file is always new, so the mode holds after the rename.

`cli/src/wasm.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHclToolkit, type HclToolkit } from '../../server/hcl/toolkit'

/** Bundled: the wasm sits beside statesman.mjs. From source: server/assets/wasm. */
function wasmDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  if (existsSync(join(here, 'tree-sitter-hcl.wasm'))) return here
  return join(here, '../../server/assets/wasm')
}

export function loadHcl(): Promise<HclToolkit> {
  const dir = wasmDir()
  return createHclToolkit(async (name) => readFileSync(join(dir, name)))
}
```

- [ ] **Step 6: Implement `commands.ts`**

```ts
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileFor, parseManifest, type Manifest } from '../../shared/schemas/manifest'
import { CliError } from './errors'
import { fetchCheckout } from './client'
import { gitIgnored, gitTracked } from './git'
import { readOrNull, writeAtomic } from './files'
import { loadHcl } from './wasm'
import { findStrays } from './strays'
import { isDrift, reportEnvironment, type FileReport } from './report'

export type RunOptions = {
  dir: string
  envs: string[]
  token: string | undefined
  serverOverride: string | undefined
  fetchImpl?: typeof fetch
}
export type Reported = FileReport & { action?: 'written' | 'refused' }
export type CommandResult = { reports: Reported[]; exitCode: 0 | 1 }

function loadManifest(dir: string): Manifest {
  const text = readOrNull(join(dir, 'statesman.json'))
  if (text === null) throw new CliError(`no statesman.json in ${dir}`, 2)
  try {
    return parseManifest(text)
  } catch (error) {
    throw new CliError((error as Error).message, 2)
  }
}

function selectEnvs(manifest: Manifest, requested: string[]): string[] {
  for (const env of requested) {
    if (!manifest.environments.includes(env)) {
      throw new CliError(`environment "${env}" is not in statesman.json (${manifest.environments.join(', ')})`, 2)
    }
  }
  return requested.length > 0 ? requested : manifest.environments
}

async function collect(opts: RunOptions): Promise<{ manifest: Manifest; reports: FileReport[] }> {
  const manifest = loadManifest(opts.dir)
  const envs = selectEnvs(manifest, opts.envs)
  if (!opts.token) throw new CliError(`set STATESMAN_TOKEN to a token with Read Variables for ${manifest.project}`, 2)
  const server = opts.serverOverride ?? manifest.server
  const checkouts = await Promise.all(
    envs.map((env) =>
      fetchCheckout({ server, project: manifest.project, env, token: opts.token!, fetchImpl: opts.fetchImpl })
    )
  )
  const hcl = await loadHcl()
  const reports = envs.flatMap((env, i) =>
    reportEnvironment({
      manifest,
      env,
      checkout: checkouts[i]!,
      read: (file) => readOrNull(join(opts.dir, file)),
      hcl
    })
  )
  const tracked = await gitTracked(opts.dir)
  for (const s of findStrays(readdirSync(opts.dir), tracked, manifest)) {
    reports.push({ env: null, file: s.file, kind: null, state: 'stray', detail: [s.env], desired: null })
  }
  return { manifest, reports }
}

export async function status(opts: RunOptions): Promise<CommandResult> {
  const { reports } = await collect(opts)
  return { reports, exitCode: reports.some(isDrift) ? 1 : 0 }
}

export async function pull(opts: RunOptions & { force: boolean }): Promise<CommandResult> {
  const manifest = loadManifest(opts.dir)
  // Before any network call or write: a vars file git would commit is a leak.
  for (const env of selectEnvs(manifest, opts.envs)) {
    const file = fileFor(manifest.files.vars, env)
    if ((await gitIgnored(opts.dir, file)) === false) {
      throw new CliError(`${file} is not gitignored and would be committed; add it to .gitignore first`, 2)
    }
  }
  const { reports } = await collect(opts)
  const out: Reported[] = reports.map((r) => {
    if (r.desired === null || r.state === 'ok') return r
    // .env lines the CLI owns are always rewritten; every other line survives.
    const mayWrite = r.state === 'missing' || r.kind === 'env' || opts.force
    if (!mayWrite) return { ...r, action: 'refused' }
    writeAtomic(join(opts.dir, r.file), r.desired, r.kind === 'vars' ? 0o600 : 0o644)
    return { ...r, action: 'written' }
  })
  const drift = out.some((r) => r.action === 'refused' || r.state === 'stray')
  return { reports: out, exitCode: drift ? 1 : 0 }
}
```

- [ ] **Step 7: Implement `output.ts` and `main.ts`**

`cli/src/output.ts`:
```ts
import type { CommandResult, Reported } from './commands'

function describe(r: Reported): string {
  if (r.action === 'written') return r.state === 'missing' ? 'written' : `updated${r.detail.length ? `: ${r.detail.join(', ')}` : ''}`
  if (r.action === 'refused') return `refused, differs: ${r.detail.join(', ')} (use --force after checking)`
  switch (r.state) {
    case 'ok': return 'ok'
    case 'missing': return 'missing'
    case 'differs': return `differs: ${r.detail.join(', ')}`
    case 'unreadable': return `unreadable: ${r.detail[0] ?? ''}`
    case 'stray': return `stray: environment "${r.detail[0] ?? ''}" not in statesman.json`
    case 'no-backend': return 'no backend settings in statesman'
  }
}

export function formatText(result: CommandResult): string {
  const envWidth = Math.max(0, ...result.reports.map((r) => (r.env ?? '').length))
  const fileWidth = Math.max(0, ...result.reports.map((r) => r.file.length))
  return result.reports
    .map((r) => `${(r.env ?? '').padEnd(envWidth)}  ${r.file.padEnd(fileWidth)}  ${describe(r)}`)
    .join('\n')
}

/** `desired` holds secrets, so it is never part of the JSON report. */
export function formatJson(result: CommandResult): string {
  return JSON.stringify(
    {
      exitCode: result.exitCode,
      files: result.reports.map(({ env, file, kind, state, detail, action }) => ({ env, file, kind, state, detail, action: action ?? null }))
    },
    null,
    2
  )
}
```

`cli/src/main.ts`:
```ts
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { CliError } from './errors'
import { pull, status } from './commands'
import { formatJson, formatText } from './output'

const USAGE = `usage:
  statesman status [--env <slug>]... [--dir <path>] [--json]
  statesman pull   [--env <slug>]... [--dir <path>] [--force] [--json]

STATESMAN_TOKEN  a token with Read Variables for the manifest's project (required)
STATESMAN_URL    overrides "server" in statesman.json`

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        env: { type: 'string', multiple: true, default: [] },
        dir: { type: 'string', default: '.' },
        force: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false }
      }
    })
    const command = positionals[0]
    if (values.help || command === 'help') {
      console.log(USAGE)
      return 0
    }
    const opts = {
      dir: resolve(values.dir),
      envs: values.env,
      token: env.STATESMAN_TOKEN || undefined,
      serverOverride: env.STATESMAN_URL || undefined
    }
    let result
    if (command === 'status') result = await status(opts)
    else if (command === 'pull') result = await pull({ ...opts, force: values.force })
    else throw new CliError(`unknown command ${command ?? '(none)'}\n${USAGE}`, 2)
    console.log(values.json ? formatJson(result) : formatText(result))
    return result.exitCode
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`statesman: ${error.message}`)
      return error.exitCode
    }
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      console.error(`statesman: ${error.message}\n${USAGE}`)
      return 2
    }
    console.error(error)
    return 2
  }
}

// Run when executed directly (bundled or via tsx), not when imported by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2), process.env)
}
```
No colour is used at all, so "no colour without a TTY" holds trivially.

- [ ] **Step 8: Run, expect PASS**

Run: `pnpm vitest run tests/unit/cli-client.test.ts tests/integration/cli-commands.test.ts tests/unit/cli-*.test.ts`
Expected: PASS. The `inside git` tests need `git` on PATH, which CI already has.

- [ ] **Step 9: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck`. If `vue-tsc` does not cover `cli/`, add `"cli/**/*.ts"` to the `include` of `tsconfig.json` and rerun.
```bash
git add cli/src tests/unit/cli-client.test.ts tests/integration/cli-commands.test.ts tsconfig.json
git commit -m "feat(cli): statesman status and pull"
```

---

### Task 9: Bundle the CLI

**Files:**
- Create: `scripts/build-cli.ts`, `tests/unit/cli-bundle.test.ts`
- Modify: `package.json` (devDependency `esbuild`, script `build:cli`), `.gitignore` (`cli/dist/`)

**Interfaces:**
- Produces: `buildCli(): Promise<string>` returning the absolute path of `cli/dist/statesman.mjs`; `pnpm build:cli`

- [ ] **Step 1: Write the failing test**

`tests/unit/cli-bundle.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildCli } from '../../scripts/build-cli'

let bin: string
beforeAll(async () => {
  bin = await buildCli()
}, 120_000)

describe('bundled CLI', () => {
  it('ships the wasm beside the bundle', () => {
    expect(existsSync(join(dirname(bin), 'tree-sitter-hcl.wasm'))).toBe(true)
    expect(existsSync(join(dirname(bin), 'web-tree-sitter.wasm'))).toBe(true)
  })
  it('prints usage', () => {
    expect(execFileSync('node', [bin, '--help'], { encoding: 'utf8' })).toContain('statesman pull')
  })
  it('exits 2 without a token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'statesman-bundle-'))
    writeFileSync(join(dir, 'statesman.json'), JSON.stringify({
      server: 'http://127.0.0.1:9', project: 'a/b', environments: ['x'], files: { vars: '{env}.tfvars' }
    }))
    const r = spawnSync('node', [bin, 'status', '--dir', dir], { encoding: 'utf8', env: { PATH: process.env.PATH } })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('set STATESMAN_TOKEN')
  })
})
```
The bundle's HCL path is exercised end to end in Task 11.

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm vitest run tests/unit/cli-bundle.test.ts`
Expected: FAIL, `scripts/build-cli` not found.

- [ ] **Step 3: Add esbuild and the script**

Run: `pnpm add -D esbuild@0.28.2` (the newest esbuild already in the lockfile, so `minimumReleaseAge` does not block it).

`scripts/build-cli.ts`:
```ts
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function buildCli(): Promise<string> {
  const outdir = join(root, 'cli/dist')
  const outfile = join(outdir, 'statesman.mjs')
  mkdirSync(outdir, { recursive: true })
  await build({
    entryPoints: [join(root, 'cli/src/main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // web-tree-sitter's ESM build still calls require() for node builtins.
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
    },
    logLevel: 'warning'
  })
  for (const name of ['web-tree-sitter.wasm', 'tree-sitter-hcl.wasm']) {
    copyFileSync(join(root, 'server/assets/wasm', name), join(outdir, name))
  }
  return outfile
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  console.log(await buildCli())
}
```
In `package.json` scripts add `"build:cli": "tsx scripts/build-cli.ts"`. In `.gitignore` add `cli/dist/`.

The `main.ts` self-run guard compares `import.meta.url` with `argv[1]`. In the bundle, `import.meta.url` is the bundle's URL, so it runs. If the guard fails on a symlinked path, compare `realpathSync(argv[1])` instead.

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm vitest run tests/unit/cli-bundle.test.ts`
Expected: PASS. If esbuild warns that `web-tree-sitter` references `.wasm` via `new URL(...)`, that is harmless: the toolkit passes `wasmBinary` explicitly.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-cli.ts tests/unit/cli-bundle.test.ts package.json pnpm-lock.yaml .gitignore
git commit -m "build(cli): bundle statesman.mjs with its wasm"
```

---

### Task 10: Backend settings panel in the dashboard

**Files:**
- Create: `app/components/BackendSettingsPanel.vue`
- Modify: `app/components/VariablesPanel.vue` (mount it under `RepositoryPanel`)

**Interfaces:**
- Consumes: `PUT /api/ui/environments/:id/backend` (Task 3), `listEnvironments` now carrying `backend`, `toTfvars` from `~~/shared/hcl/tfvars`, `useProjectRole`, `statusMessageOf`, `ProjectOnly`
- Produces: `<BackendSettingsPanel :environment-id :backend :role @changed>`

- [ ] **Step 1: Read the neighbours**

Read `app/components/RepositoryPanel.vue` in full and `VariablesPanel.vue` lines 150–260. Copy their card layout, heading size, `ProjectOnly` usage, `UModal` pattern and error display. Do not invent new spacing or colours.

- [ ] **Step 2: Implement the component**

`app/components/BackendSettingsPanel.vue`:
```vue
<script setup lang="ts">
import type { BackendSettings } from '~~/shared/schemas/backend'
import type { EffectiveRole } from '~~/shared/project-permissions'
import { toTfvars } from '~~/shared/hcl/tfvars'
import { statusMessageOf } from '~/utils/status-message'

const props = defineProps<{
  environmentId: string
  backend: BackendSettings | null
  role: EffectiveRole | null | undefined
}>()
const emit = defineEmits<{ changed: [] }>()
const { can } = useProjectRole(toRef(props, 'role'))

const open = ref(false)
const text = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const entries = computed(() => Object.entries(props.backend ?? {}).sort(([a], [b]) => a.localeCompare(b)))

function edit() {
  text.value = props.backend ? toTfvars(props.backend) : ''
  error.value = null
  open.value = true
}

async function save() {
  saving.value = true
  error.value = null
  try {
    await $fetch(`/api/ui/environments/${props.environmentId}/backend`, {
      method: 'PUT',
      body: { hcl: text.value }
    })
    open.value = false
    emit('changed')
  } catch (e) {
    error.value = statusMessageOf(e, 'Could not save. Check your connection, then try again.')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="space-y-3">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold">Backend settings</h3>
        <p class="text-sm text-muted">
          Written to the backend file by <code>statesman pull</code>. Not encrypted; never put credentials here.
        </p>
      </div>
      <ProjectOnly :role="role" permission="environment:configure">
        <UButton color="neutral" variant="outline" size="sm" @click="edit">
          {{ backend ? 'Edit' : 'Add backend settings' }}
        </UButton>
      </ProjectOnly>
    </div>

    <p v-if="!backend" class="text-sm text-muted">
      None. <code>statesman pull</code> writes no backend file for this environment.
    </p>
    <table v-else class="w-full text-sm">
      <tbody>
        <tr v-for="[key, value] in entries" :key="key" class="border-t border-default">
          <td class="py-1.5 pr-4 font-mono" translate="no">{{ key }}</td>
          <td class="py-1.5 font-mono break-all" translate="no">{{ String(value) }}</td>
        </tr>
      </tbody>
    </table>

    <UModal v-model:open="open" title="Backend settings">
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-muted">
            Paste a backend config file, one <code>name = value</code> per line. Leave it empty to remove the settings.
          </p>
          <UTextarea v-model="text" :rows="8" class="w-full font-mono" autoresize spellcheck="false" />
          <UAlert v-if="error" color="error" variant="subtle" :description="error" />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">Cancel</UButton>
          <UButton :loading="saving" @click="save">Save</UButton>
        </div>
      </template>
    </UModal>
  </section>
</template>
```
Adjust class names to match what `RepositoryPanel.vue` uses (Step 1); the structure stays.

- [ ] **Step 3: Mount it**

In `VariablesPanel.vue`, directly after the `<RepositoryPanel … />` element (line ~222), add:
```vue
      <BackendSettingsPanel
        v-if="env"
        :environment-id="env.id"
        :backend="env.backend"
        :role="role"
        @changed="refreshEnvironments()"
      />
```
`env` is the selected environment computed at line 24 and now carries `backend` from the list route.

- [ ] **Step 4: Typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Look at it**

Run `pnpm dev`, sign in as an admin, open a project's Variables tab, and with the Playwright MCP take screenshots of: the empty state; the modal with pasted HCL; the filled table; the modal showing a refused `secret_key` error; the panel as a viewer (no button). Check the right edge of the table with a 2048-character value (it must wrap, not overflow), and that Esc closes the modal. Fix anything clipped before committing.

- [ ] **Step 6: Commit**

```bash
git add app/components/BackendSettingsPanel.vue app/components/VariablesPanel.vue
git commit -m "feat(ui): backend settings panel on the Variables tab"
```

---

### Task 11: End-to-end with real Terraform

**Files:**
- Create: `tests/e2e/fixture-checkout/main.tf`, `tests/e2e/checkout-cli.test.ts`

**Interfaces:**
- Consumes: everything above; `buildCli` (Task 9)

- [ ] **Step 1: Add the fixture**

`tests/e2e/fixture-checkout/main.tf`:
```hcl
# A local backend with no path: the path comes from backend.<env>.hcl, which is
# what proves the CLI's backend file reaches `terraform init`.
terraform {
  required_version = ">= 1.6"
  backend "local" {}
}

variable "value" {
  type = string
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

`tests/e2e/checkout-cli.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { auth } from '../../server/utils/auth'
import { createEnvironment, setBackend, setVariable } from '../../server/services/variables'
import { resetDb, seedProject, provisionUser } from '../protocol/helpers'
import { buildCli } from '../../scripts/build-cli'

await setup({ server: true })

const sh = promisify(execFile)
const ORG = 'checkout-e2e'
let dir: string
let bin: string
let token: string
let userId: string
let clientEnvId: string

const cli = (...args: string[]) =>
  spawnSync('node', [bin, ...args, '--dir', dir], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, STATESMAN_TOKEN: token }
  })

const terraform = (env: string, args: string) =>
  sh('sh', ['-c', `set -a; . ./.env.${env}; set +a; terraform ${args}`], {
    cwd: dir,
    env: { PATH: process.env.PATH, TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' }
  })

beforeAll(async () => {
  bin = await buildCli()
  await resetDb(ORG)
  const projectId = await seedProject(ORG, 'app')
  userId = (await provisionUser(`checkout-e2e-${Date.now()}@example.com`, 'correct horse battery', 'admin')).id
  for (const [slug, value] of [['internal', 'in'], ['client', 'cl']] as const) {
    const env = await createEnvironment(projectId, slug)
    if (slug === 'client') clientEnvId = env.id
    await setVariable({ environmentId: env.id, name: 'value', input: { value, sensitive: true }, userId })
    await setVariable({ environmentId: env.id, name: 'replicas', input: { value: 2, sensitive: false }, userId })
    await setBackend(env.id, { path: `${slug}.tfstate` })
  }
  token = (
    await auth.api.createApiKey({
      body: {
        userId,
        name: 'checkout-e2e',
        permissions: { state: [], vars: ['read'] },
        metadata: { scope: { kind: 'projects', projects: [`${ORG}/app`] } }
      }
    })
  ).key
  dir = mkdtempSync(join(tmpdir(), 'statesman-checkout-'))
  cpSync(fileURLToPath(new URL('fixture-checkout', import.meta.url)), dir, { recursive: true })
  writeFileSync(
    join(dir, 'statesman.json'),
    JSON.stringify({
      server: new URL(absoluteUrl('/')).origin,
      project: `${ORG}/app`,
      environments: ['internal', 'client'],
      files: { vars: '{env}.tfvars', backend: 'backend.{env}.hcl', env: '.env.{env}' }
    })
  )
}, 180_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('statesman pull with real terraform', () => {
  it('writes six files that terraform uses for each environment', async () => {
    const r = cli('pull')
    expect(r.status, r.stderr).toBe(0)
    for (const env of ['internal', 'client']) {
      for (const f of [`${env}.tfvars`, `backend.${env}.hcl`, `.env.${env}`]) expect(existsSync(join(dir, f))).toBe(true)
      await terraform(env, 'init -no-color')
      await terraform(env, 'apply -auto-approve -no-color')
      const { stdout } = await terraform(env, 'output -raw canary')
      expect(stdout.trim()).toBe(`${env === 'internal' ? 'in' : 'cl'}-2`)
      expect(existsSync(join(dir, `${env}.tfstate`))).toBe(true)
      expect(existsSync(join(dir, `.terraform-${env}`))).toBe(true)
    }
    expect(cli('status').status).toBe(0)
  }, 300_000)

  it('detects a dashboard change, refuses without --force, keeps foreign .env lines', async () => {
    await setVariable({ environmentId: clientEnvId, name: 'replicas', input: { value: 5, sensitive: false }, userId })
    const s = cli('status')
    expect(s.status).toBe(1)
    expect(s.stdout).toMatch(/client\.tfvars\s+differs: replicas/)
    expect(s.stdout).not.toContain('"cl"')

    expect(cli('pull').status).toBe(1)
    appendFileSync(join(dir, '.env.client'), 'AWS_PROFILE=client-profile\n')
    expect(cli('pull', '--force').status).toBe(0)
    expect(cli('status').status).toBe(0)
    expect(readFileSync(join(dir, '.env.client'), 'utf8')).toContain('AWS_PROFILE=client-profile')
  })
})
```

- [ ] **Step 3: Run**

Run: `pnpm test:e2e -- tests/e2e/checkout-cli.test.ts`
Expected: PASS. If `terraform init` rejects `path` for the local backend via `-backend-config`, check the Terraform version on PATH (≥ 1.6 supports it) before changing the fixture.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/fixture-checkout tests/e2e/checkout-cli.test.ts
git commit -m "test(e2e): statesman pull drives real terraform for two environments"
```

---

### Task 12: Documentation

**Files:**
- Create: `docs/cli.md`
- Modify: `README.md`, `docs/backend-config.md`, `docs/superpowers/specs/2026-10-09-variables-design.md`, `docs/superpowers/specs/2026-10-13-checkout-cli-design.md`

- [ ] **Step 1: Write `docs/cli.md`**

Sections, in this order, in the style of `docs/backend-config.md` (short sentences, tables for reference):
1. **What it does**: one paragraph.
2. **Install**: `pnpm build:cli` in a statesman checkout, then `alias statesman="node /path/to/statesman/cli/dist/statesman.mjs"`. State that it is not on npm yet.
3. **`statesman.json`**: the field table and every refusal from spec §5, with the error text each produces.
4. **Commands**: `status` and `pull`, every flag, the exit-code table, the example `status` output from spec §7.
5. **What `pull` writes**: the three files, mode `0600` for vars, the `.env` owned keys and the rule that other lines are kept, `--force` applying to vars and backend files only.
6. **In CI**: a GitHub Actions step: `node statesman.mjs pull --env client` with `STATESMAN_TOKEN` from secrets, then `set -a; . ./.env.client; set +a; terraform plan`; and `statesman status --json` as a gate.
7. **Errors**: each message from spec §7 and what to do.

- [ ] **Step 2: README**

Add a "Setting up a machine" section after "Variables": what the manifest is, `statesman status` then `statesman pull`, a link to `docs/cli.md`. In the Variables section, add one paragraph on **Backend settings** (where the panel is, who can edit: owners and admins, that values are not encrypted and credential-like names are refused). Add a "Edit backend settings" row to the roles table (owner, admin).

- [ ] **Step 3: `docs/backend-config.md`**

Add a short section "Using another backend": a project on `s3` (or any backend) can store its backend config in statesman and have `statesman pull` write it; link `docs/cli.md`.

- [ ] **Step 4: Specs**

At the top of the variables spec add: `> **2026-10-13:** environments gained backend settings and a checkout endpoint; see [2026-10-13-checkout-cli-design.md](2026-10-13-checkout-cli-design.md).` In the checkout spec set `**Status:** Implemented. Plan: docs/superpowers/plans/2026-10-13-checkout-cli.md.`

- [ ] **Step 5: Check the manual against the code**

For each command, flag, error message and exit code in `docs/cli.md`, find it in `cli/src/` and confirm it matches. Fix whichever side is wrong.

- [ ] **Step 6: Run the full suite, format, commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: PASS.
```bash
git add docs/cli.md README.md docs/backend-config.md docs/superpowers/specs/2026-10-09-variables-design.md docs/superpowers/specs/2026-10-13-checkout-cli-design.md
git commit -m "docs: checkout CLI reference and backend settings"
```
