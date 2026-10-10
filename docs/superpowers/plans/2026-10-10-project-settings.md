# Project Settings and Account Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners rename and describe projects; admins archive, unarchive, delete and set retention per project; every role sees the backend block; admins create accounts from the dashboard.

**Architecture:** Four nullable columns on `project`. Archive is enforced at two choke points — `requireProjectPermission` (dashboard) and `tf-handler` (Terraform) — rather than per route. Delete removes blobs before rows so a retry converges. Account creation goes through Better Auth's admin `createUser`, which re-checks the caller's admin session.

**Tech Stack:** Nuxt 4, Nitro/h3, Drizzle (Postgres), Better Auth 1.7 (admin + organization plugins), Zod 4, Nuxt UI 4, vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-project-settings-design.md`

## Global Constraints

- Slugs never change. No code path writes `project.slug`.
- `name`: trimmed, 1–64 chars. `description`: ≤ 500 chars, `''` stores `null`.
- Retention fields: positive integers or `null` (= deployment default). Admin only.
- Archived refusal: HTTP **409**, message `Project <org>/<slug> is archived. An admin can unarchive it.` (dashboard routes: `This project is archived. An admin can unarchive it.`).
- Archived allow-list: `project:read`, `project:unlock`, `project:update`, `variable:download`, `member:manage`.
- Delete requires archived (409 `Archive the project before deleting it.`); blobs first, then rows.
- Archive while locked: 409 `The state is locked. Let the run finish or force-unlock it, then archive.`
- No `window.confirm`; `UModal` for every confirmation. No `any`.
- Audit actions: `project.update`, `project.archive`, `project.unarchive`, `project.delete`, `user.create`.
- Conventional Commits; stage explicit paths.

## Review Focus

1. **A token with `all` scope writing to an archived project** — expect 409, not success: the archived check must sit in tf-handler, not in token-scope logic. Pinned in Task 6.
2. **Unlock on an archived project** — must still work, or a lock left by a crashed run before archiving can never be cleared. Pinned in Task 6.
3. **Delete retried after a blob-store failure** — expect the retry to finish cleanly with no 500 on the already-missing blobs. Pinned in Task 5.
4. **Renaming to whitespace only** — expect 400, not a blank project name. Pinned in Task 1.
5. **Creating an account with an email that differs from an existing one only by case** — expect 409, not a second account. Pinned in Task 8.

---

### Task 1: Columns, shared schemas, effective retention

**Files:**
- Modify: `server/db/schema.ts` (project table)
- Create: `drizzle/0004_*.sql` via `pnpm db:generate`
- Modify: `shared/schemas/project.ts`
- Modify: `server/services/retention.ts`
- Test: `tests/unit/project-settings.test.ts`, `tests/protocol/retention.test.ts`

**Interfaces:**
- Produces: `updateProjectSchema` / `UpdateProjectInput`; `effectiveRetention(p: RetentionOverride, d: RetentionOverride & {...}): { keepVersions: number; keepDays: number; source: { versions: 'default' | 'project'; days: 'default' | 'project' } }`; columns `project.description`, `project.archivedAt`, `project.retentionKeepVersions`, `project.retentionKeepDays`.

- [ ] **Step 1: Failing unit tests**

```ts
import { describe, it, expect } from 'vitest'
import { updateProjectSchema } from '../../shared/schemas/project'
import { effectiveRetention } from '../../shared/retention'

describe('updateProjectSchema', () => {
  it('trims the name', () => {
    expect(updateProjectSchema.parse({ name: '  Prod  ' })).toEqual({ name: 'Prod' })
  })
  it.each(['', '   ', 'x'.repeat(65)])('rejects name %j', (name) => {
    expect(updateProjectSchema.safeParse({ name }).success).toBe(false)
  })
  it('stores an empty description as null', () => {
    expect(updateProjectSchema.parse({ description: '  ' })).toEqual({ description: null })
  })
  it('rejects a 501 character description', () => {
    expect(updateProjectSchema.safeParse({ description: 'x'.repeat(501) }).success).toBe(false)
  })
  it('accepts null retention as "use the default"', () => {
    expect(updateProjectSchema.parse({ retentionKeepDays: null })).toEqual({ retentionKeepDays: null })
  })
  it.each([0, -1, 1.5])('rejects retention %j', (n) => {
    expect(updateProjectSchema.safeParse({ retentionKeepVersions: n }).success).toBe(false)
  })
  it('rejects slug in the body', () => {
    expect(updateProjectSchema.safeParse({ slug: 'other' }).success).toBe(false)
  })
})

describe('effectiveRetention', () => {
  const defaults = { keepVersions: 100, keepDays: 30 }
  it('falls back per field', () => {
    expect(effectiveRetention({ keepVersions: 5, keepDays: null }, defaults)).toEqual({
      keepVersions: 5,
      keepDays: 30,
      source: { versions: 'project', days: 'default' }
    })
  })
})
```

`effectiveRetention` lives in `shared/retention.ts` so the Settings tab can show the source without restating the rule.

- [ ] **Step 2:** `pnpm vitest run tests/unit/project-settings.test.ts` → FAIL (missing exports).

- [ ] **Step 3: Implement**

`shared/schemas/project.ts`:

```ts
const retention = z.number().int().positive().max(100_000).nullable()

/** Body of `PATCH /api/ui/projects/:id`. Strict: the slug is not a setting (spec §1). */
export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    description: z
      .string()
      .max(500)
      .transform((s) => (s.trim() === '' ? null : s.trim()))
      .nullable(),
    retentionKeepVersions: retention,
    retentionKeepDays: retention
  })
  .partial()
  .strict()
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>
```

`shared/retention.ts`:

```ts
export type RetentionValues = { keepVersions: number; keepDays: number }
export type RetentionOverride = { keepVersions: number | null; keepDays: number | null }
export type RetentionSource = 'default' | 'project'

/** Each null falls back to the deployment's value on its own (spec §6). */
export function effectiveRetention(
  override: RetentionOverride,
  defaults: RetentionValues
): RetentionValues & { source: { versions: RetentionSource; days: RetentionSource } } {
  return {
    keepVersions: override.keepVersions ?? defaults.keepVersions,
    keepDays: override.keepDays ?? defaults.keepDays,
    source: {
      versions: override.keepVersions === null ? 'default' : 'project',
      days: override.keepDays === null ? 'default' : 'project'
    }
  }
}
```

`server/db/schema.ts` project table gains:

```ts
    description: text('description'),
    archivedAt: timestamp('archived_at'),
    retentionKeepVersions: integer('retention_keep_versions'),
    retentionKeepDays: integer('retention_keep_days'),
```

Run `pnpm db:generate` and review the SQL: four `ALTER TABLE "project" ADD COLUMN` lines, nothing else.

- [ ] **Step 4: Retention honours the override — failing protocol test** in `tests/protocol/retention.test.ts`:

```ts
  it('uses the project override over the deployment default', async () => {
    await db().update(project).set({ retentionKeepVersions: 2, retentionKeepDays: 1 }).where(eq(project.id, projectId))
    for (let i = 1; i <= 5; i++) await seedOldVersion(i)
    await writeState({ projectId, orgSlug: ORG, projectSlug: 'prod', body: body(99), userId: 'u' })
    await runRetention(projectId)
    expect((await listVersions(projectId)).length).toBe(2)
  })
```

- [ ] **Step 5:** In `runRetention`, select the two columns and use `effectiveRetention({ keepVersions, keepDays }, { keepVersions: config.RETENTION_KEEP_VERSIONS, keepDays: config.RETENTION_KEEP_DAYS })` for `cutoff` and the index threshold.

- [ ] **Step 6:** `pnpm test tests/unit/project-settings.test.ts tests/protocol/retention.test.ts` → PASS.

- [ ] **Step 7:** Commit `feat: add project settings columns and per-project retention`.

---

### Task 2: `project:update` and the archived guard

**Files:**
- Modify: `shared/project-permissions.ts`, `server/utils/project-access.ts`
- Test: `tests/integration/project-settings.test.ts` (new; owns org `settings`)

**Interfaces:**
- Produces: permission `'project:update'` (owner); `ARCHIVED_ALLOWED: ReadonlySet<ProjectPermission>`; `requireProjectPermission` throws 409 on archived projects for other permissions; `requireTokenAuthority` throws 409 for an archived project in scope (admins included).

- [ ] **Step 1: Failing tests** — integration file scaffold with actors admin/owner/editor/viewer (copy the `beforeAll` and `fresh()` pattern from `tests/integration/members.test.ts`; set `archivedAt` directly via `db().update(project)`):

```ts
it('refuses variable writes on an archived project with 409', async () => {
  const pid = await fresh()
  await archive(pid)
  await expect(requireProjectPermission(testEvent({ headers: u.owner.h }), pid, 'variable:write'))
    .rejects.toMatchObject({ statusCode: 409 })
})
it.each(['project:read', 'project:unlock', 'project:update', 'variable:download', 'member:manage'] as const)(
  'still allows %s on an archived project', async (perm) => {
    const pid = await fresh()
    await archive(pid)
    await expect(requireProjectPermission(testEvent({ headers: u.owner.h }), pid, perm)).resolves.toBeTruthy()
  })
it('answers 403, not 409, to a viewer asking for an owner permission on an archived project', async () => {
  // Role first: a viewer learns nothing new from a 409.
})
it('refuses a token naming an archived project, admins included', async () => { /* requireTokenAuthority */ })
```

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement.** `shared/project-permissions.ts`: add `'project:update'` to the union and `MIN_ROLE` (owner). `project-access.ts`: `projectStatements.project` gains `'update'`; owner role gains it; `REQUESTS['project:update'] = { project: ['update'] }`.

```ts
/** What still works on an archived project (spec §5). Everything else is 409. */
export const ARCHIVED_ALLOWED: ReadonlySet<ProjectPermission> = new Set([
  'project:read', 'project:unlock', 'project:update', 'variable:download', 'member:manage'
])
export const ARCHIVED = 'This project is archived. An admin can unarchive it.'
```

In `requireProjectPermission`, after the 403 check (role checks come first), when `!ARCHIVED_ALLOWED.has(permission)` select `archivedAt` and throw 409 `ARCHIVED` if set. The admin existence check and this read can share one query: select `{ id, archivedAt }` once.

In `requireTokenAuthority`, resolve every ref (admins too) and 409 if any is archived; keep the admin early return for the ownership half only. `kind: 'all'` is unaffected (enforced at tf-handler).

- [ ] **Step 4:** run → PASS; also `pnpm vitest run tests/unit` (the UI/server role-table parity test must still pass).
- [ ] **Step 5:** Commit `feat: refuse changes to archived projects at the permission guard`.

---

### Task 3: `PATCH /api/ui/projects/:id`

**Files:**
- Create: `server/api/ui/projects/[id].patch.ts`, `server/services/projects.ts`
- Test: `tests/integration/project-settings.test.ts`

**Interfaces:**
- Consumes: `updateProjectSchema`, `requireProjectPermission(…, 'project:update')`.
- Produces: `updateProject(input: { projectId: string; actorId: string; changes: UpdateProjectInput }): Promise<void>`; route returns `{ ok: true }`.

- [ ] **Step 1: Failing tests**

```ts
it('lets an owner rename and describe', async () => {
  const pid = await fresh()
  await patch(u.owner, pid, { name: 'Production', description: 'Main account' })
  const [row] = await db().select().from(project).where(eq(project.id, pid))
  expect(row).toMatchObject({ name: 'Production', description: 'Main account' })
  const [access] = await db().select().from(projectAccess).where(eq(projectAccess.id, pid))
  expect(access?.name).toBe('Production')
})
it('refuses an editor with 403', async () => { expect(await status(patch(u.editor, pid, { name: 'x' }))).toBe(403) })
it('refuses retention from an owner with 403', async () => {
  expect(await status(patch(u.owner, pid, { retentionKeepDays: 7 }))).toBe(403)
})
it('lets an admin set and clear retention', async () => { /* 7 then null */ })
it('rejects a slug field with 400', async () => { /* strict schema */ })
it('audits field names, not values', async () => {
  // meta: { fields: ['description', 'name'] }
})
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** route: `requireProjectPermission(event, id, 'project:update')` first (before body), then `readValidatedBody(event, updateProjectSchema.parse)`; if `'retentionKeepVersions' in body || 'retentionKeepDays' in body` and `principal.projectRole !== 'admin'` → 403 `Only an admin can change retention.` Service: one `update(project).set(changes)`; if `name` present also `update(projectAccess).set({ name })`; `recordAuditBestEffort({ action: 'project.update', meta: { fields: Object.keys(changes).toSorted() } })`. An empty body is a 200 no-op without audit.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: let owners rename and describe projects`.

---

### Task 4: Archive and unarchive

**Files:**
- Create: `server/api/ui/projects/[id]/archive.post.ts`, `server/api/ui/projects/[id]/unarchive.post.ts`
- Modify: `server/services/projects.ts`
- Test: `tests/integration/project-settings.test.ts`

**Interfaces:**
- Produces: `setArchived(input: { projectId: string; actorId: string; archived: boolean }): Promise<void>`.

- [ ] **Step 1: Failing tests:** admin archives → `archivedAt` set, audit `project.archive`; second archive → 200, still one audit row; owner → 403; unknown id → 404; locked project (insert `stateLock` row) → 409 with the locked message; unarchive clears and audits; unarchive of active project → 200 no audit.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** Routes: `requireAdmin`, validate `id`, call `setArchived`. Service: load project (404 `NOT_FOUND` from project-access if missing); if already in the requested state return; if archiving and `currentLock(projectId)` → 409; `update(project).set({ archivedAt: archived ? new Date() : null })`; audit.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: let admins archive and unarchive projects`.

---

### Task 5: Delete

**Files:**
- Create: `server/api/ui/projects/[id].delete.ts`
- Modify: `server/services/projects.ts`
- Test: `tests/integration/project-settings.test.ts`

**Interfaces:**
- Produces: `deleteProject(input: { projectId: string; actorId: string }): Promise<{ versions: number; blobs: number }>`.

- [ ] **Step 1: Failing tests:**

```ts
it('refuses to delete an active project with 409', …)
it('refuses a non-admin with 403', …)
it('removes every blob and row, and keeps the audit record', async () => {
  const pid = await fresh()
  await writeState({ projectId: pid, orgSlug: ORG, projectSlug: slugOf(pid), body: Buffer.from('{"version":4,"serial":1}'), userId: u.admin.id })
  await archive(pid)
  await del(u.admin, pid)
  expect(await store().list(`${ORG}/${slugOf(pid)}/`)).toEqual([])
  expect(await db().select().from(project).where(eq(project.id, pid))).toEqual([])
  expect(await db().select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.action, 'project.delete')))).toHaveLength(1)
})
it('finishes on retry after the blobs were already removed', async () => {
  // delete blobs by hand first, then deleteProject → resolves, rows gone
})
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** Load `{ slug, orgSlug, archivedAt }` (404 if none); 409 if not archived; count versions; `for (const key of await store().list(\`${org}/${slug}/\`)) await store().delete(key)`; audit `project.delete` `{ org, project, versions }` (awaited, best-effort); then delete `projectState` for the id first (its FK to `state_version` is RESTRICT and cascades from project in undefined order), then `project`. Local and S3 `delete` of a missing key must not throw — verify against `tests/integration/storage.conformance.ts`; if it does, catch only "not found".
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: let admins delete archived projects`.

---

### Task 6: Terraform refuses writes to archived projects

**Files:**
- Modify: `server/utils/tf-handler.ts`, `server/api/tf/[org]/[project]/index.ts`
- Test: `tests/protocol/archived.test.ts` (new; `setup({ server: true })`, org `archived-suite`)

**Interfaces:**
- Produces: `ResolvedProject.archived: boolean`; `assertWritable(resolved: ResolvedProject): void` (409).

- [ ] **Step 1: Failing tests** using an `all`-scope admin token and a project-scoped token (pattern from `tests/protocol/endpoints.test.ts` `beforeAll`): after archiving, `GET` → 200 (seed one version first), `POST` state → 409 with body text containing `archived`, `DELETE` → 409, `POST /lock` → 409, `LOCK` verb → 409, `DELETE /lock` (releasing a lock inserted before archiving) → 200, `GET /api/vars/...` → unchanged status.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** `resolveProject` selects `archivedAt` and returns `archived: row.archivedAt !== null`. `assertWritable` throws `createError({ statusCode: 409, statusMessage: \`Project ${ref.org}/${ref.project} is archived. An admin can unarchive it.\` })`. Call it at the top of `handleLockAcquire` and in index.ts before the POST and DELETE branches.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: refuse terraform writes and locks on archived projects`.

---

### Task 7: Project list carries the new fields

**Files:**
- Modify: `server/api/ui/projects.get.ts`
- Test: `tests/integration/project-list.test.ts`

- [ ] **Step 1: Failing test:** the row for an archived, described project has `archived: true`, `description`, `name`, and `retention: { keepVersions, keepDays, source }`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** select `description`, `archivedAt`, the two retention columns; map to `archived: archivedAt !== null`, `retention: effectiveRetention(...)` with `env()` defaults, and drop the raw columns from the row.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: return name, description, archive and retention in the project list`.

---

### Task 8: Create accounts from the dashboard

**Files:**
- Create: `server/api/ui/users.post.ts`
- Modify: `shared/schemas/user.ts`, `server/services/users.ts`, `server/services/members.ts`
- Test: `tests/integration/users-service.test.ts`

**Interfaces:**
- Produces: `createUserSchema = z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().max(64).optional(), role: userRoleSchema })`; `createAccount(input: { actorId: string; email: string; name?: string; role: UserRole; headers: Headers }): Promise<{ id: string; email: string; password: string }>`.

- [ ] **Step 1: Failing tests:** admin creates → returned password signs in (`signInHeaders`), role matches; member caller → 403; existing email in different case → 409; audit `user.create` with `{ email, role }`, never the password; members 404 message contains `Users page`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** Service: check `lower(email)` exists → 409 `An account with that email already exists.`; `password = randomBytes(18).toString('base64url')`; `auth.api.createUser({ body: { email, password, name: name || email.split('@')[0], role }, headers })`; audit; return. Route: `requireAdmin` before body. Update the `addMember` message.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: let admins create accounts from the dashboard`.

---

### Task 9: Settings tab

**Files:**
- Create: `app/components/ProjectSettingsPanel.vue`, `app/components/ProjectArchiveModal.vue`, `app/components/ProjectDeleteModal.vue`
- Modify: `app/pages/projects/[org]/[project]/index.vue`, `app/pages/index.vue`

Behaviour (spec §7):
- `tabItems` gains `{ label: 'Settings', value: 'settings' }`; `tab` getter accepts `'settings'`.
- Header: `current.name` as `h1`; when `name !== slug`, `org/slug` under it in `font-mono text-sm text-muted`. "Archived" neutral badge. Archived banner (`UAlert` warning, `i-lucide-archive`): "This project is archived. Terraform can read its state, but writes, locks and changes are refused until an admin unarchives it."
- Panel sections, each a `section` with `h2`:
  - General: `UForm` with `updateProjectSchema.pick({name, description})` when `can('project:update')`, else `dl`. Save → PATCH → `emit('changed')` → page `refreshProjects()`.
  - Backend configuration: `<pre><code>{{ backendSnippet({ origin, org, project }) }}</code></pre>` + Copy button (reuse ProjectCreateModal's copy pattern).
  - Retention: two numeric inputs for admins (blank = default) showing "Default (N)" placeholders; read-only `dl` with "(deployment default)" / "(this project)" otherwise.
  - Danger zone (admins): Archive/Unarchive button → `ProjectArchiveModal`; Delete button disabled unless archived, with helper text "Archive the project first."; → `ProjectDeleteModal` with a text input that must equal `org/slug`; on success `navigateTo('/?deleted=org/slug')` and the list toasts it.
- Project list: show `name` (and slug under it when different), description (`line-clamp-2`), Archived badge; `USwitch` "Show archived" rendered only when some row is archived; hidden by default.

- [ ] **Step 1:** Implement components. **Step 2:** `pnpm typecheck && pnpm lint`. **Step 3:** Commit `feat: add a project settings tab`.

---

### Task 10: New User on the Users page

**Files:**
- Create: `app/components/UserCreateModal.vue`
- Modify: `app/pages/users.vue`, `app/components/MemberAddModal.vue`

- [ ] **Step 1:** Modal: email, name (optional), role select (Member default). Submit → `POST /api/ui/users` → emit `created({ email, password })`; page sets `revealed` (existing `PasswordRevealModal`) and refreshes. Replace the "made from the command line" copy with "Create accounts with **New User**, or `pnpm user:create` from a shell." `MemberAddModal`: when `useAuth().isAdmin` and the error is the 404, show a `ULink to="/users"` "Create the account on the Users page".
- [ ] **Step 2:** typecheck, lint. **Step 3:** Commit `feat: add a New User button to the Users page`.

---

### Task 11: Manual

**Files:** `README.md`

- [ ] Roles table rows: "Edit name and description" (owner, admin); "Archive, unarchive, delete, set retention" (admin); "Create accounts" moves into "Manage accounts…" row text. New `## Project settings` section after Variables covering the four Settings sections, what archive refuses (with the 409), delete prerequisites and permanence. "Adding people" step 1: Users page → **New User**, or the CLI. Operational notes: per-project retention override.
- [ ] Commit `docs: document project settings and dashboard account creation`.

---

### Task 12: Verify rendered output

- [ ] `pnpm dev`, sign in as admin and as an owner and a viewer. Screenshot: Settings tab per role, archived project page, archive modal, delete modal (typed and untyped), project list with and without Show archived, Users → New User modal and reveal. Check the right edge and bottom of each, and that Esc closes each modal.
- [ ] Full `pnpm test`, `pnpm typecheck`, `pnpm lint`.
