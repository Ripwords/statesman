# Project Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-project `viewer` / `editor` / `owner` roles stored with Better Auth's organization plugin, enforced on every project-scoped UI route and on every token request, with a Members tab for owners.

**Architecture:** Each project gets a 1:1 Better Auth "organization" row (`project_access`, same id as `project`). Membership rows (`project_member`) carry the role. One server module (`server/utils/project-access.ts`) answers every question: effective role (deployment admin short-circuits), `projectCan(role, permission)` via the plugin's access-control role objects, and a `requireProjectPermission` guard that answers 404 to non-members. Tokens are re-checked against their creator's current role on every Terraform request.

**Tech Stack:** Nuxt 4.6 / Nitro, Vue 3.5, Nuxt UI 4, Drizzle 0.45 (node-pg and neon-http — no interactive transactions), Better Auth 1.7.2 (`admin`, `organization`, `@better-auth/api-key`), zod 4, vitest 4, oxlint/oxfmt (husky pre-commit).

**Spec:** `docs/superpowers/specs/2026-10-09-project-access-design.md` (approved, all §12 decisions as written).

## Global Constraints

- Two levels only: deployment admin (`user.role = 'admin'`, admin plugin) and a project role. No org layer, no teams, no email invitations, no self sign-up.
- Project roles are exactly `viewer`, `editor`, `owner`.
- Plugin tables are renamed: `organization` → model `projectAccess` (table `project_access`), `member` → `projectMember` (`project_member`), `invitation` → `projectInvitation` (`project_invitation`). The existing statesman `organization` table is untouched.
- `project_access.id` equals `project.id`. `project_access.slug` is set to the project id.
- The plugin's "active organization" is never consulted.
- `/api/auth/organization/*` answers 404.
- Non-member on any project-scoped route → **404, identical** status and message to an unknown id. Role too low → **403** `Needs {role} access to this project. Ask a project owner.`
- Add member, unknown email → 404 `No account with that email. An admin creates accounts.`; already a member → 409 `{email} is already a {role} on this project.`
- Token creator lost access → 403 `The account that created this token no longer has access to {org}/{project}`. Token for a non-owned project → 403 `You can only create tokens for projects you own.`
- Migration backfill: every non-admin account becomes `viewer` on every existing project. Admins get no rows.
- Zero owners is allowed. The UI warns before the last owner leaves.
- Audit actions: `member.add`, `member.role`, `member.remove`.
- Sensitive variables stay write-only for every role (vars spec §7).
- No `any`. `as unknown as X` only where strictly necessary. No `window.confirm` / `alert` / `prompt`; use the app's modal. Data fetching in pages via `useFetch` (as existing pages do), never `fetch` + `useEffect`-style watchers.
- TDD: every task writes the failing test first.
- Commits: Conventional Commits, stage explicit paths, never `git add -A`, never `-c user.email`.
- Manual (README + `docs/backend-config.md`) is updated in the same branch (Task 8).

## Rulings made while planning

- **R1. `delete` state action floor.** The spec's §7 floor table lists `read`, `write`, `lock`. `stateActionSchema` also has `delete`. Floor for `delete` is `editor`, same as `write` — it is a write.
- **R2. Member writes use Drizzle on the plugin's tables, not `getOrgAdapter`.** Spec §6 says "through the plugin's adapter". The adapter's typing is internal and unexported for this use; the tables are ours (we declare them in `server/db/schema.ts`), so Drizzle writes the same rows with types we control. The plugin still owns the schema shape and role definitions. Cost if wrong: none at runtime — the plugin reads the same rows.
- **R3. Token list shows the caller's own tokens, for admins too.** Spec §7 says "an admin sees every token (as today)". Today `listApiKeys({ headers })` already returns only the session user's keys, so "as today" is own-tokens. Kept as-is; the tokens page becomes reachable for admins and for owners of ≥1 project.
- **R4. Plugin's "creator gets owner" does not apply.** We never call the plugin's create endpoint; `creatorRole` is still set to `'owner'` for completeness.

## Review Focus

1. **A member who had a session before the upgrade** opens a project they are no longer a member of (removed after migration): expect a clean 404 page, not a 500 or an empty table. → Task 4 test "removed member gets 404 on every project route".
2. **Environment / version / variable ids from another project**: a viewer of project A passes an environment id belonging to project B: expect 404, never B's data. → Task 4 test "cross-project environment id is 404".
3. **Email case and whitespace on Add Member** (`  Alice@Example.com `): expect it to match `alice@example.com`. → Task 5 test "matches email case-insensitively and trims".
4. **Owner demotes themselves mid-session** then clicks Remove on someone: expect 403 from the server even though the stale UI still shows the button. → Task 5 test "a demoted owner's next member write is 403".
5. **Token created by an owner who is later deleted as an account**: expect the token to stop working (member row cascades away, `referenceId` user gone) with 403/401, not a 500. → Task 6 test "token of a deleted creator is refused".

---

## File Structure

| File | Responsibility |
| --- | --- |
| `shared/schemas/project-role.ts` (create) | `projectRoleSchema`, `ProjectRole`, member-route body schemas. Shared by server and UI. |
| `server/utils/project-access.ts` (create) | Access-control statements, the three roles, `projectCan`, `effectiveRole`, `effectiveRoleOfUser`, `requireProjectPermission`, `projectIdOfEnvironment`, `projectIdOfVersion`, `ensureAccessRecord`, `NOT_FOUND`. |
| `server/services/members.ts` (create) | List/add/change/remove members, with audit. |
| `server/db/schema.ts` (modify) | `projectAccess`, `projectMember`, `projectInvitation` tables; `session.activeOrganizationId`. |
| `server/utils/auth.ts` (modify) | Register `organization(...)` plugin. |
| `server/api/auth/[...all].ts` (modify) | 404 for `/api/auth/organization/*`. |
| `drizzle/0003_*.sql` (generate + append backfill) | Tables + backfill. |
| `server/api/ui/projects/[id]/members.get.ts`, `members.post.ts`, `members/[userId].patch.ts`, `members/[userId].delete.ts` (create) | Member routes. |
| Every route in spec §6 inventory (modify) | Swap guard. |
| `server/utils/tf-auth.ts` (modify) | `requireCreatorAccess`. |
| `server/api/ui/tokens*.ts` (modify) | Creation rules, visibility. |
| `tests/protocol/helpers.ts` (modify) | `grantProjectRole`, `resetDb` also clears access rows. |
| `tests/integration/project-access.test.ts` (create) | Guard, role resolution, migration backfill. |
| `tests/integration/route-roles.test.ts` (rewrite) | The role × route matrix. |
| `tests/integration/members.test.ts` (create) | Member management. |
| `tests/protocol/token-ceiling.test.ts` (create) | Token use-time and creation rules. |
| `app/composables/useProjectRole.ts` (create) | `can(permission)` for the current project, from `myRole`. |
| `app/components/ProjectOnly.vue` (create) | Like `AdminOnly`, gated on a project permission. |
| `app/components/MembersPanel.vue`, `MemberAddModal.vue` (create) | Members tab. |
| `app/pages/index.vue`, `projects/[org]/[project]/index.vue`, `tokens.vue`, `users.vue`, `layouts/dashboard.vue`, `components/VariablesPanel.vue`, `RepositoryPanel.vue`, `LockBanner.vue`, `TokenConfigurator.vue` (modify) | Role-aware UI. |
| `README.md`, `docs/backend-config.md` (modify) | Manual. |

---

### Task 1: Tables, plugin registration, migration with backfill

**Files:**
- Modify: `server/db/schema.ts` (session table ~line 37; append after `organization`/`project` app tables ~line 150; add to the exported `schema` object ~line 279)
- Modify: `server/utils/auth.ts`
- Modify: `server/api/auth/[...all].ts`
- Create: `shared/schemas/project-role.ts`
- Create: `server/utils/project-access.ts` (statements and roles only in this task)
- Generate: `drizzle/0003_<name>.sql` + `drizzle/meta/*`
- Modify: `tests/protocol/helpers.ts`
- Test: `tests/integration/project-access.test.ts`

**Interfaces:**
- Produces: tables `projectAccess`, `projectMember`, `projectInvitation` exported from `server/db/schema.ts`; `projectRoleSchema`, `type ProjectRole` from `shared/schemas/project-role.ts`; `projectAc`, `projectRoles` from `server/utils/project-access.ts`; test helper `grantProjectRole(projectId: string, userId: string, role: ProjectRole): Promise<void>`; `seedProject` now also inserts the `project_access` row.

- [ ] **Step 1: Write the failing tests**

`tests/integration/project-access.test.ts`:

```ts
import { testEvent } from '../ui/nitro-globals'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { describe, it, expect } from 'vitest'
import { ulid } from 'ulid'
import authCatchAll from '../../server/api/auth/[...all]'

/**
 * The backfill runs inside a transaction that is always rolled back: it is a
 * cross join over every user and every project, and other suites share this
 * database in parallel. Committing it would make their non-members viewers.
 */
describe('migration backfill', () => {
  it('makes every non-admin a viewer on every project and gives admins no rows', async () => {
    const file = readdirSync('drizzle').find((f) => f.startsWith('0003_'))
    expect(file).toBeDefined()
    const sql = readFileSync(join('drizzle', file ?? ''), 'utf8')
    const backfill = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('INSERT INTO "project_access"') || s.startsWith('INSERT INTO "project_member"'))
    expect(backfill).toHaveLength(2)

    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      await client.query('BEGIN')
      const orgId = ulid()
      const p1 = ulid()
      const p2 = ulid()
      const admin = ulid()
      const m1 = ulid()
      const m2 = ulid()
      await client.query(`insert into organization (id, name, slug) values ($1, $1, $1)`, [orgId])
      await client.query(
        `insert into project (id, org_id, name, slug) values ($1, $3, 'a', 'a'), ($2, $3, 'b', 'b')`,
        [p1, p2, orgId]
      )
      await client.query(
        `insert into "user" (id, name, email, email_verified, role, created_at, updated_at) values
          ($1, 'a', $1 || '@t.test', false, 'admin', now(), now()),
          ($2, 'm', $2 || '@t.test', false, 'member', now(), now()),
          ($3, 'n', $3 || '@t.test', false, null, now(), now())`,
        [admin, m1, m2]
      )
      for (const statement of backfill) await client.query(statement)

      const access = await client.query(`select id from project_access where id = any($1)`, [[p1, p2]])
      expect(access.rowCount).toBe(2)
      const members = await client.query(
        `select organization_id, user_id, role from project_member where organization_id = any($1) order by user_id`,
        [[p1, p2]]
      )
      expect(members.rows.filter((r) => r.user_id === admin)).toHaveLength(0)
      expect(members.rows.filter((r) => r.user_id === m1).map((r) => r.role)).toEqual(['viewer', 'viewer'])
      expect(members.rows.filter((r) => r.user_id === m2).map((r) => r.role)).toEqual(['viewer', 'viewer'])
    } finally {
      await client.query('ROLLBACK')
      await client.end()
    }
  })
})

describe('/api/auth/organization/*', () => {
  it('answers 404 so the plugin endpoints are not a second door', async () => {
    const event = testEvent({ headers: {} })
    Object.assign(event, { path: '/api/auth/organization/add-member', method: 'POST' })
    await expect(authCatchAll(event)).rejects.toMatchObject({ statusCode: 404 })
  })
})
```

Check the real column names in the `user` table in `server/db/schema.ts` before running (adjust `email_verified`/`created_at`/`updated_at` to match the actual snake_case names there; do not change the assertions).

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run tests/integration/project-access.test.ts`
Expected: FAIL — no `0003_` migration; catch-all does not 404.

- [ ] **Step 3: Shared role schema**

`shared/schemas/project-role.ts`:

```ts
import { z } from 'zod'

/**
 * A role on ONE project. Deployment-wide authority is `user.role`
 * (shared/schemas/user.ts); this is the second and last level.
 */
export const projectRoleSchema = z.enum(['viewer', 'editor', 'owner'])
export type ProjectRole = z.infer<typeof projectRoleSchema>

/** Body of `POST /api/ui/projects/:id/members`. */
export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: projectRoleSchema
})
export type AddMemberInput = z.infer<typeof addMemberSchema>

/** Body of `PATCH /api/ui/projects/:id/members/:userId`. */
export const changeMemberRoleSchema = z.object({ role: projectRoleSchema })
```

- [ ] **Step 4: Access-control roles**

`server/utils/project-access.ts` (this task: statements and roles only; Task 2 adds the rest):

```ts
import { createAccessControl } from 'better-auth/plugins/access'

/**
 * What a project role may do, in the organization plugin's vocabulary.
 * Spec §3 is the table; this is its only encoding. No route compares role
 * strings — they ask `projectCan`, which asks these objects.
 */
export const projectStatements = {
  project: ['read', 'rollback', 'unlock'],
  environment: ['create', 'delete', 'link', 'sync'],
  variable: ['write'],
  member: ['manage'],
  token: ['create']
} as const

export const projectAc = createAccessControl(projectStatements)

export const projectRoles = {
  viewer: projectAc.newRole({ project: ['read'] }),
  editor: projectAc.newRole({
    project: ['read', 'unlock'],
    environment: ['sync'],
    variable: ['write']
  }),
  owner: projectAc.newRole({
    project: ['read', 'rollback', 'unlock'],
    environment: ['create', 'delete', 'link', 'sync'],
    variable: ['write'],
    member: ['manage'],
    token: ['create']
  })
}
```

- [ ] **Step 5: Tables**

In `server/db/schema.ts`, add to the `session` table:

```ts
  // Added by the organization plugin. statesman never reads it: URLs name the
  // project, and a session-wide "active" project would let one tab change
  // another tab's authority (project-access spec §6).
  activeOrganizationId: text('active_organization_id'),
```

After the `project` table, add (field names must match the plugin's schema in
`node_modules/better-auth/dist/plugins/organization/organization.mjs` around
lines 700–830 — open it and compare `organization`, `member`, `invitation`
fields; the JS property names below are the plugin's field names):

```ts
// --- Project access (Better Auth organization plugin, renamed) ---------------
//
// The plugin calls these "organization", "member" and "invitation". statesman
// already has an `organization` table (the deployment slug), so the plugin's
// models are renamed in server/utils/auth.ts and live here. One access row per
// project, same id, so a project id IS the plugin's organization id.

export const projectAccess = pgTable('project_access', {
  id: text('id')
    .primaryKey()
    .references(() => project.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  createdAt: timestamp('created_at').notNull().defaultNow()
})

export const projectMember = pgTable(
  'project_member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => projectAccess.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow()
  },
  (t) => [uniqueIndex('project_member_org_user_uq').on(t.organizationId, t.userId)]
)

// Required by the plugin's schema; statesman has no mail transport and never
// writes to it (spec §1 non-goals).
export const projectInvitation = pgTable('project_invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => projectAccess.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow()
})
```

Add `projectAccess, projectMember, projectInvitation` to the exported `schema` object (the one passed to `drizzleAdapter`), keyed by those exact names — the adapter looks models up by `modelName`.

- [ ] **Step 6: Register the plugin**

In `server/utils/auth.ts`, import `organization` from `'better-auth/plugins'` (next to `admin`) and `projectAc, projectRoles` from `./project-access`. Add to `plugins`, after `admin(...)`:

```ts
    // Per-project roles (project-access spec). A Better Auth "organization" is
    // a statesman PROJECT here. Nothing in the browser reaches the plugin's own
    // endpoints — api/auth/[...all].ts answers 404 for them — so these options
    // describe the data, and server/utils/project-access.ts is the door.
    organization({
      ac: projectAc,
      roles: projectRoles,
      creatorRole: 'owner',
      allowUserToCreateOrganization: false,
      schema: {
        organization: { modelName: 'projectAccess' },
        member: { modelName: 'projectMember' },
        invitation: { modelName: 'projectInvitation' }
      }
    }),
```

Update the `emailAndPassword` comment that says "every authenticated user can read every project's decrypted state" to say accounts read only projects they hold a role on.

- [ ] **Step 7: Block the plugin's HTTP endpoints**

`server/api/auth/[...all].ts`:

```ts
import { auth } from '../../utils/auth'

/**
 * The organization plugin's endpoints check authority against plugin
 * membership alone, which would refuse a deployment admin who is not a member
 * and would let an owner act outside statesman's audit. Member management goes
 * through /api/ui/projects/:id/members only (project-access spec §6).
 */
const BLOCKED = '/api/auth/organization/'

export default defineEventHandler((event) => {
  if (event.path.startsWith(BLOCKED)) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  return auth.handler(toWebRequest(event))
})
```

- [ ] **Step 8: Generate the migration and append the backfill**

Run: `pnpm db:generate` → creates `drizzle/0003_<name>.sql`. Open it and append, after the last generated statement:

```sql
--> statement-breakpoint
INSERT INTO "project_access" ("id", "name", "slug", "created_at")
SELECT "id", "name", "id", now() FROM "project"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "project_member" ("id", "organization_id", "user_id", "role", "created_at")
SELECT gen_random_uuid()::text, p."id", u."id", 'viewer', now()
FROM "project" p CROSS JOIN "user" u
WHERE coalesce(u."role", 'member') <> 'admin'
ON CONFLICT ("organization_id", "user_id") DO NOTHING;
```

Apply to dev and test DBs: `pnpm db:migrate && pnpm db:migrate:test`.

- [ ] **Step 9: Test helpers**

In `tests/protocol/helpers.ts`:
- `seedProject` also inserts `projectAccess` `{ id: projectId, name: projectSlug, slug: projectId }`.
- `resetDb`: no change needed (cascades from `project`), but confirm by reading it.
- Add:

```ts
/** Gives an account a role on one project, the way an owner's Add Member does. */
export async function grantProjectRole(
  projectId: string,
  userId: string,
  role: ProjectRole
): Promise<void> {
  await db()
    .insert(projectMember)
    .values({ id: ulid(), organizationId: projectId, userId, role })
    .onConflictDoUpdate({
      target: [projectMember.organizationId, projectMember.userId],
      set: { role }
    })
}
```

- [ ] **Step 10: Run tests**

Run: `pnpm vitest run tests/integration/project-access.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS. Then the full suite `pnpm test` — expected PASS (no route changed yet; new tables are additive).

- [ ] **Step 11: Commit**

```bash
git add shared/schemas/project-role.ts server/utils/project-access.ts server/db/schema.ts server/utils/auth.ts "server/api/auth/[...all].ts" drizzle tests/protocol/helpers.ts tests/integration/project-access.test.ts
git commit -m "feat: add project access tables via the organization plugin"
```

---

### Task 2: Effective role, `projectCan`, and the guard

**Files:**
- Modify: `server/utils/project-access.ts`
- Test: `tests/unit/project-can.test.ts` (create), `tests/integration/project-access.test.ts` (extend)

**Interfaces:**
- Consumes: `projectRoles`, `projectMember`, `projectAccess`, `requireSession`/`Principal` from `server/utils/ui-auth.ts`, `roleOf` from `shared/schemas/user.ts`.
- Produces:
  - `type ProjectPermission = 'project:read' | 'project:rollback' | 'project:unlock' | 'environment:create' | 'environment:delete' | 'environment:link' | 'environment:sync' | 'variable:write' | 'member:manage' | 'token:create'`
  - `type EffectiveRole = ProjectRole | 'admin'`
  - `projectCan(role: EffectiveRole, permission: ProjectPermission): boolean`
  - `effectiveRole(actor: { userId: string; role: UserRole }, projectId: string): Promise<EffectiveRole | null>`
  - `effectiveRoleOfUser(userId: string, projectId: string): Promise<EffectiveRole | null>` (loads `user.role`; returns null for a missing user)
  - `requireProjectPermission(event: H3Event, projectId: string, permission: ProjectPermission): Promise<Principal & { projectRole: EffectiveRole }>`
  - `projectIdOfEnvironment(environmentId: string): Promise<string>` / `projectIdOfVersion(versionId: string): Promise<string>` — throw `NOT_FOUND` if unknown
  - `NOT_FOUND` statusMessage constant `'Unknown project. Check the project id and try again.'`
  - `ensureAccessRecord(projectId: string, name: string): Promise<void>` (idempotent)
  - `minimumRoleFor(permission: ProjectPermission): ProjectRole`

- [ ] **Step 1: Failing unit test for the role table**

`tests/unit/project-can.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { projectCan, minimumRoleFor, type ProjectPermission } from '../../server/utils/project-access'

// Spec §3, row by row. `null` = no project role may do it.
const TABLE: Array<[ProjectPermission, boolean, boolean, boolean]> = [
  //                          viewer editor owner
  ['project:read', true, true, true],
  ['project:unlock', false, true, true],
  ['environment:sync', false, true, true],
  ['variable:write', false, true, true],
  ['environment:create', false, false, true],
  ['environment:delete', false, false, true],
  ['environment:link', false, false, true],
  ['project:rollback', false, false, true],
  ['member:manage', false, false, true],
  ['token:create', false, false, true]
]

describe.each(TABLE)('%s', (permission, viewer, editor, owner) => {
  it('matches spec §3 for each project role', () => {
    expect(projectCan('viewer', permission)).toBe(viewer)
    expect(projectCan('editor', permission)).toBe(editor)
    expect(projectCan('owner', permission)).toBe(owner)
  })

  it('is always allowed for a deployment admin', () => {
    expect(projectCan('admin', permission)).toBe(true)
  })

  it('names the lowest role that may do it, for the 403 message', () => {
    expect(minimumRoleFor(permission)).toBe(viewer ? 'viewer' : editor ? 'editor' : 'owner')
  })
})
```

- [ ] **Step 2: Failing integration tests for the guard**

Append to `tests/integration/project-access.test.ts`:

```ts
import { isApiError } from '../ui/nitro-globals'
import { beforeAll } from 'vitest'
import { provisionUser, signInHeaders, setRole, resetDb, seedProject, grantProjectRole } from '../protocol/helpers'
import { db } from '../../server/db/client'
import { projectAccess } from '../../server/db/schema'
import { eq } from 'drizzle-orm'
import {
  requireProjectPermission,
  effectiveRoleOfUser,
  ensureAccessRecord
} from '../../server/utils/project-access'

const ORG = 'project-access'
const PASSWORD = 'correct horse battery staple'
let projectId: string
const ids: Record<string, string> = {}
const headers: Record<string, Record<string, string>> = {}

beforeAll(async () => {
  await resetDb(ORG)
  projectId = await seedProject(ORG, 'p')
  const stamp = Date.now()
  for (const name of ['admin', 'owner', 'editor', 'viewer', 'stranger'] as const) {
    const u = await provisionUser(`pa-${name}-${stamp}@example.com`, PASSWORD)
    await setRole(u.id, name === 'admin' ? 'admin' : 'member')
    if (name === 'owner' || name === 'editor' || name === 'viewer') {
      await grantProjectRole(projectId, u.id, name)
    }
    ids[name] = u.id
    headers[name] = Object.fromEntries((await signInHeaders(u.email, PASSWORD)).entries())
  }
})

async function refusal(call: Promise<unknown>): Promise<{ status?: number; message?: string }> {
  try {
    await call
    return {}
  } catch (error) {
    return isApiError(error) ? { status: error.statusCode, message: error.statusMessage } : {}
  }
}

describe('requireProjectPermission', () => {
  it('answers a stranger exactly as it answers an unknown project', async () => {
    const stranger = await refusal(
      requireProjectPermission(testEvent({ headers: headers.stranger }), projectId, 'project:read')
    )
    const unknown = await refusal(
      requireProjectPermission(testEvent({ headers: headers.viewer }), 'no-such-project', 'project:read')
    )
    expect(stranger).toEqual({ status: 404, message: 'Unknown project. Check the project id and try again.' })
    expect(unknown).toEqual(stranger)
  })

  it('answers 403 naming the role needed when the role is too low', async () => {
    expect(
      await refusal(requireProjectPermission(testEvent({ headers: headers.viewer }), projectId, 'variable:write'))
    ).toEqual({ status: 403, message: 'Needs editor access to this project. Ask a project owner.' })
  })

  it('lets an admin through with no membership row', async () => {
    const p = await requireProjectPermission(testEvent({ headers: headers.admin }), projectId, 'member:manage')
    expect(p.projectRole).toBe('admin')
  })

  it('returns the member role', async () => {
    const p = await requireProjectPermission(testEvent({ headers: headers.editor }), projectId, 'variable:write')
    expect(p.projectRole).toBe('editor')
  })

  it('answers 401 with no session, before anything else', async () => {
    expect((await refusal(requireProjectPermission(testEvent(), 'anything', 'project:read'))).status).toBe(401)
  })
})

describe('effectiveRoleOfUser', () => {
  it('is null for a user id that does not exist', async () => {
    expect(await effectiveRoleOfUser('nobody', projectId)).toBeNull()
  })
})

describe('ensureAccessRecord', () => {
  it('recreates a missing access record and is idempotent', async () => {
    const p = await seedProject(ORG, 'healed')
    await db().delete(projectAccess).where(eq(projectAccess.id, p))
    await ensureAccessRecord(p, 'healed')
    await ensureAccessRecord(p, 'healed')
    expect(await db().select().from(projectAccess).where(eq(projectAccess.id, p))).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run, verify failure**

Run: `pnpm vitest run tests/unit/project-can.test.ts tests/integration/project-access.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 4: Implement**

Append to `server/utils/project-access.ts`:

```ts
import type { H3Event } from 'h3'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { environment, projectAccess, projectMember, stateVersion, user } from '../db/schema'
import { projectRoleSchema, type ProjectRole } from '../../shared/schemas/project-role'
import { isAdmin, roleOf, type UserRole } from '../../shared/schemas/user'
import { requireSession, type Principal } from './ui-auth'

export type ProjectPermission =
  | 'project:read'
  | 'project:rollback'
  | 'project:unlock'
  | 'environment:create'
  | 'environment:delete'
  | 'environment:link'
  | 'environment:sync'
  | 'variable:write'
  | 'member:manage'
  | 'token:create'

export type EffectiveRole = ProjectRole | 'admin'

/** Each permission as the request the plugin's role objects understand. */
const REQUESTS = {
  'project:read': { project: ['read'] },
  'project:rollback': { project: ['rollback'] },
  'project:unlock': { project: ['unlock'] },
  'environment:create': { environment: ['create'] },
  'environment:delete': { environment: ['delete'] },
  'environment:link': { environment: ['link'] },
  'environment:sync': { environment: ['sync'] },
  'variable:write': { variable: ['write'] },
  'member:manage': { member: ['manage'] },
  'token:create': { token: ['create'] }
} as const satisfies Record<ProjectPermission, object>

export function projectCan(role: EffectiveRole, permission: ProjectPermission): boolean {
  if (role === 'admin') return true
  return projectRoles[role].authorize(REQUESTS[permission]).success
}

const ASCENDING: ProjectRole[] = ['viewer', 'editor', 'owner']

/** The lowest project role that may do this. Used for the 403 message only. */
export function minimumRoleFor(permission: ProjectPermission): ProjectRole {
  return ASCENDING.find((role) => projectCan(role, permission)) ?? 'owner'
}

/** The 404 a non-member and an unknown id share, byte for byte (spec §6, D2). */
export const NOT_FOUND = 'Unknown project. Check the project id and try again.'

function notFound(): never {
  throw createError({ statusCode: 404, statusMessage: NOT_FOUND })
}

/**
 * The one question every project-scoped check asks. A deployment admin is
 * `admin` on every project, membership row or not. An unrecognised role string
 * in the column resolves to no access — least privilege, as roleOf does.
 */
export async function effectiveRole(
  actor: { userId: string; role: UserRole },
  projectId: string
): Promise<EffectiveRole | null> {
  if (isAdmin(actor.role)) return 'admin'
  const rows = await db()
    .select({ role: projectMember.role })
    .from(projectMember)
    .where(and(eq(projectMember.organizationId, projectId), eq(projectMember.userId, actor.userId)))
  const parsed = projectRoleSchema.safeParse(rows[0]?.role)
  return parsed.success ? parsed.data : null
}

/** effectiveRole for a caller known only by id — a token's creator. */
export async function effectiveRoleOfUser(
  userId: string,
  projectId: string
): Promise<EffectiveRole | null> {
  const rows = await db().select({ role: user.role }).from(user).where(eq(user.id, userId))
  const found = rows[0]
  if (!found) return null
  return effectiveRole({ userId, role: roleOf(found.role) }, projectId)
}

/**
 * The guard for every project-scoped /api/ui route. 401 without a session,
 * then 404 for no role (identical to an unknown project), then 403 naming
 * the role needed.
 *
 * An admin asking about a project id that does not exist also gets 404: the
 * existence check runs for admins too, so a guard pass always means the
 * project is real.
 */
export async function requireProjectPermission(
  event: H3Event,
  projectId: string,
  permission: ProjectPermission
): Promise<Principal & { projectRole: EffectiveRole }> {
  const principal = await requireSession(event)
  const exists = await db()
    .select({ id: projectAccess.id })
    .from(projectAccess)
    .where(eq(projectAccess.id, projectId))
  const role = await effectiveRole(principal, projectId)
  if (role === null) notFound()
  if (exists.length === 0 && role !== 'admin') notFound()
  if (!projectCan(role, permission)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Needs ${minimumRoleFor(permission)} access to this project. Ask a project owner.`
    })
  }
  return { ...principal, projectRole: role }
}

export async function projectIdOfEnvironment(environmentId: string): Promise<string> {
  const rows = await db()
    .select({ projectId: environment.projectId })
    .from(environment)
    .where(eq(environment.id, environmentId))
  return rows[0]?.projectId ?? notFound()
}

export async function projectIdOfVersion(versionId: string): Promise<string> {
  const rows = await db()
    .select({ projectId: stateVersion.projectId })
    .from(stateVersion)
    .where(eq(stateVersion.id, versionId))
  return rows[0]?.projectId ?? notFound()
}

/**
 * Creates the access row for a project that lacks one (spec §4: a crash
 * between the two inserts). Idempotent.
 */
export async function ensureAccessRecord(projectId: string, name: string): Promise<void> {
  await db()
    .insert(projectAccess)
    .values({ id: projectId, name, slug: projectId })
    .onConflictDoNothing({ target: projectAccess.id })
}
```

Note on the admin + missing access record case: an admin passes for a real project whose access row is missing (spec §4 self-heal). For an admin and an id that is neither a project nor an access row, the route's own lookup still 404s — that is existing behaviour and stays. Move the `import` lines to the top of the file with the existing one.

If `projectRoles[role].authorize(REQUESTS[permission])` does not typecheck because the union of request shapes is not assignable, replace the call with a `switch (permission)` that calls `authorize` with each literal — do not cast.

- [ ] **Step 5: Run**

Run: `pnpm vitest run tests/unit/project-can.test.ts tests/integration/project-access.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/utils/project-access.ts tests/unit/project-can.test.ts tests/integration/project-access.test.ts
git commit -m "feat: resolve project roles and guard project routes"
```

---

### Task 3: Project creation and the filtered project list

**Files:**
- Modify: `server/api/ui/projects.post.ts`, `server/api/ui/projects.get.ts`
- Test: `tests/integration/project-list.test.ts` (create)

**Interfaces:**
- Consumes: `ensureAccessRecord`, `effectiveRole`-equivalent filtering, `projectMember`.
- Produces: `GET /api/ui/projects` rows gain `myRole: EffectiveRole`. Non-admins get only projects with a membership row.

- [ ] **Step 1: Failing test**

`tests/integration/project-list.test.ts`:

```ts
import { testEvent } from '../ui/nitro-globals'
import { describe, it, expect, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { provisionUser, signInHeaders, setRole, resetDb, seedOrg, seedProject, grantProjectRole } from '../protocol/helpers'
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
    const [row] = await db().select({ id: project.id }).from(project).where(eq(project.slug, 'fresh'))
    expect(await db().select().from(projectAccess).where(eq(projectAccess.id, row?.id ?? ''))).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run, verify failure** — `pnpm vitest run tests/integration/project-list.test.ts` → FAIL (member sees both; no `myRole`; no access row).

- [ ] **Step 3: Implement**

`projects.post.ts`: after the successful insert (where the row count says a row was written), call `await ensureAccessRecord(id, input.project)`. Keep the 409 path unchanged.

`projects.get.ts`: replace `await requireSession(event)` with `const principal = await requireSession(event)`. Left-join `projectMember` on `and(eq(projectMember.organizationId, project.id), eq(projectMember.userId, principal.userId))`, select `memberRole: projectMember.role`. For non-admins add `.where(isNotNull(projectMember.id))`. Map rows to add `myRole`:

```ts
  const admin = isAdmin(principal.role)
  const rows = await query
  return rows.map(({ memberRole, ...row }) => ({
    ...row,
    // Admins are `admin` everywhere (spec §3). A member row with an
    // unrecognised role string was filtered by the parse, not trusted.
    myRole: admin ? ('admin' as const) : (projectRoleSchema.safeParse(memberRole).data ?? null)
  })).filter((row) => row.myRole !== null)
```

Build the query conditionally with `admin ? base : base.where(isNotNull(projectMember.id))` — Drizzle's builder is immutable-ish per call, so assign the base select to a variable before `.orderBy`, or use `.where(admin ? undefined : isNotNull(projectMember.id))` (Drizzle accepts `undefined`).

Update the file's doc comment: the list is filtered by membership.

- [ ] **Step 4: Run** — `pnpm vitest run tests/integration/project-list.test.ts && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/ui/projects.get.ts server/api/ui/projects.post.ts tests/integration/project-list.test.ts
git commit -m "feat: filter the project list by membership"
```

---

### Task 4: Guard every project-scoped route; rewrite the role matrix

**Files:**
- Modify (guard swap): `server/api/ui/projects/[id]/versions.get.ts`, `server/api/ui/versions/[id].get.ts`, `server/api/ui/projects/[id]/lock.delete.ts`, `server/api/admin/rollback.post.ts`, `server/api/ui/projects/[id]/environments.get.ts`, `server/api/ui/projects/[id]/environments.post.ts`, `server/api/ui/environments/[id].delete.ts`, `server/api/ui/environments/[id]/variables.get.ts`, `server/api/ui/environments/[id]/variables/[name].put.ts`, `server/api/ui/environments/[id]/variables/[name].delete.ts`, `server/api/ui/environments/[id]/variables/import.post.ts`, `server/api/ui/environments/[id]/link.put.ts`, `server/api/ui/environments/[id]/link.delete.ts`, `server/api/ui/environments/[id]/sync.post.ts`, `server/api/ui/github/installations/[id]/repositories.get.ts`
- Rewrite: `tests/integration/route-roles.test.ts`
- Modify: any existing suite that drives these routes with a `member` session expecting success (at least `tests/ui/variables.test.ts`, `tests/ui/diff.test.ts`, `tests/ui/lock.test.ts`, `tests/ui/api.test.ts`, `tests/integration/github-routes.test.ts`) — add `grantProjectRole(projectId, memberId, 'viewer')` in their `beforeAll`.

**Interfaces:**
- Consumes: `requireProjectPermission`, `projectIdOfEnvironment`, `projectIdOfVersion`, `NOT_FOUND` from Task 2.
- Produces: `ownsAnyProject(userId: string): Promise<boolean>` in `server/utils/project-access.ts` (used here and in Task 6).

**Order of checks in every route:** session (401) → validate params (400) → resolve project id (404) → permission (404/403) → body. The params validation moving before the permission check is fine: a malformed id is still 400 for anyone, and the route already validated before it read anything. Body is still read only after the guard.

Pattern for an environment-keyed route (apply to every `environments/[id]/*` route; use the permission from the table below):

```ts
export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const session = await requireProjectPermission(event, await projectIdOfEnvironment(id), 'variable:write')
  // ...unchanged from here, using session.userId as before
})
```

`requireProjectPermission` calls `requireSession` itself; the explicit first call keeps "anonymous → 401 before 400" for routes whose params might be malformed. That is two `getSession` calls per request; acceptable (cookie cache) — if a reviewer objects, pass the principal through instead by adding an optional `principal` parameter.

| Route file | Project id from | Permission |
| --- | --- | --- |
| `projects/[id]/versions.get.ts` | param `id` | `project:read` |
| `versions/[id].get.ts` | `projectIdOfVersion(id)` | `project:read` |
| `projects/[id]/lock.delete.ts` | param `id` | `project:unlock` |
| `admin/rollback.post.ts` | body `projectId` (read body after `requireSession`; then guard; then the rest) | `project:rollback` |
| `projects/[id]/environments.get.ts` | param `id` | `project:read` |
| `projects/[id]/environments.post.ts` | param `id` | `environment:create` |
| `environments/[id].delete.ts` | `projectIdOfEnvironment` | `environment:delete` |
| `environments/[id]/variables.get.ts` | `projectIdOfEnvironment` | `project:read` |
| `environments/[id]/variables/[name].put.ts` | `projectIdOfEnvironment` | `variable:write` |
| `environments/[id]/variables/[name].delete.ts` | `projectIdOfEnvironment` | `variable:write` |
| `environments/[id]/variables/import.post.ts` | `projectIdOfEnvironment` | `variable:write` |
| `environments/[id]/link.put.ts` | `projectIdOfEnvironment` | `environment:link` |
| `environments/[id]/link.delete.ts` | `projectIdOfEnvironment` | `environment:link` |
| `environments/[id]/sync.post.ts` | `projectIdOfEnvironment` | `environment:sync` |
| `github/installations/[id]/repositories.get.ts` | — | session + (`isAdmin` or `ownsAnyProject`) else 403 `Needs owner access to a project. Ask an admin.` |

`rollback.post.ts` reads the body before the guard because the project id is in it; a malformed body from a signed-in non-member is a 400, which reveals nothing about any project. Keep its existing "Unknown project" 404 lookup after the guard (admins reach it).

Delete each route's now-stale "admin-only" comments and replace with one line naming the permission.

Add to `server/utils/project-access.ts`:

```ts
/** True when the account owns at least one project. Gates the tokens page and repository listing. */
export async function ownsAnyProject(userId: string): Promise<boolean> {
  const rows = await db()
    .select({ id: projectMember.id })
    .from(projectMember)
    .where(and(eq(projectMember.userId, userId), eq(projectMember.role, 'owner')))
    .limit(1)
  return rows.length > 0
}
```

- [ ] **Step 1: Rewrite the matrix test (failing)**

Replace `tests/integration/route-roles.test.ts` with a single table: each row is `[name, call(headers, ids), expected]` where `expected` maps each actor to the expected outcome. Actors: `anonymous`, `stranger` (member, no role), `viewer`, `editor`, `owner`, `admin`. Outcomes: `401`, `404`, `403`, or `'pass'` (meaning: the status is none of 401/403/404-NOT_FOUND — the call may still fail on its own terms, e.g. an empty body's 400).

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { testEvent, isApiError } from '../ui/nitro-globals'
import { provisionUser, signInHeaders, setRole, resetDb, seedProject, grantProjectRole } from '../protocol/helpers'
import { db } from '../../server/db/client'
import { environment, projectMember, stateVersion } from '../../server/db/schema'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { NOT_FOUND } from '../../server/utils/project-access'
// ...import every handler listed in the "Interfaces" table above, plus
// listProjects, createProject, tokens (list/create/delete), github install/setup/status,
// retention, users list — exactly as the current file does.

type Actor = 'anonymous' | 'stranger' | 'viewer' | 'editor' | 'owner' | 'admin'
type Outcome = 401 | 403 | 404 | 'pass'
type Ids = { projectId: string; envId: string; versionId: string }

const PASSWORD = 'correct horse battery staple'
const ORG = 'route-roles'
const headers = {} as Record<Actor, Record<string, string>>
let ids: Ids

beforeAll(async () => {
  await resetDb(ORG)
  const projectId = await seedProject(ORG, 'p')
  const envId = ulid()
  await db().insert(environment).values({ id: envId, projectId, slug: 'dev' })
  const versionId = ulid()
  // Look at server/db/schema.ts for stateVersion's required columns and fill them.
  await db().insert(stateVersion).values({ id: versionId, projectId, sizeBytes: 0, md5: 'x', blobKey: `missing/${versionId}` })
  ids = { projectId, envId, versionId }
  headers.anonymous = {}
  const stamp = Date.now()
  for (const actor of ['stranger', 'viewer', 'editor', 'owner', 'admin'] as const) {
    const u = await provisionUser(`rr-${actor}-${stamp}@example.com`, PASSWORD)
    await setRole(u.id, actor === 'admin' ? 'admin' : 'member')
    if (actor === 'viewer' || actor === 'editor' || actor === 'owner') await grantProjectRole(projectId, u.id, actor)
    headers[actor] = Object.fromEntries((await signInHeaders(u.email, PASSWORD)).entries())
  }
})

// read     = viewer+     | write = editor+ | own = owner+ | adm = admin only
const READ: Record<Actor, Outcome> = { anonymous: 401, stranger: 404, viewer: 'pass', editor: 'pass', owner: 'pass', admin: 'pass' }
const EDIT: Record<Actor, Outcome> = { anonymous: 401, stranger: 404, viewer: 403, editor: 'pass', owner: 'pass', admin: 'pass' }
const OWN: Record<Actor, Outcome> = { anonymous: 401, stranger: 404, viewer: 403, editor: 403, owner: 'pass', admin: 'pass' }
const ADMIN: Record<Actor, Outcome> = { anonymous: 401, stranger: 403, viewer: 403, editor: 403, owner: 403, admin: 'pass' }
const ANY_SESSION: Record<Actor, Outcome> = { anonymous: 401, stranger: 'pass', viewer: 'pass', editor: 'pass', owner: 'pass', admin: 'pass' }
const OWNER_SOMEWHERE: Record<Actor, Outcome> = { anonymous: 401, stranger: 403, viewer: 403, editor: 403, owner: 'pass', admin: 'pass' }

const ROUTES: Array<[string, (h: Record<string, string>, i: Ids) => Promise<unknown>, Record<Actor, Outcome>]> = [
  ['GET /api/ui/projects', (h) => listProjects(testEvent({ headers: h })), ANY_SESSION],
  ['POST /api/ui/projects', (h) => createProject(testEvent({ headers: h, body: { project: 'x' } })), ADMIN],
  ['GET /api/ui/projects/:id/versions', (h, i) => listVersions(testEvent({ headers: h, params: { id: i.projectId } })), READ],
  ['GET /api/ui/versions/:id', (h, i) => readVersion(testEvent({ headers: h, params: { id: i.versionId } })), READ],
  ['DELETE /api/ui/projects/:id/lock', (h, i) => forceUnlock(testEvent({ headers: h, params: { id: i.projectId } })), EDIT],
  ['POST /api/admin/rollback', (h, i) => rollback(testEvent({ headers: h, body: { projectId: i.projectId, versionId: 'none' } })), OWN],
  ['GET /api/ui/projects/:id/environments', (h, i) => listEnvironments(testEvent({ headers: h, params: { id: i.projectId } })), READ],
  ['POST /api/ui/projects/:id/environments', (h, i) => createEnvironment(testEvent({ headers: h, params: { id: i.projectId }, body: {} })), OWN],
  ['DELETE /api/ui/environments/:id', (h) => deleteEnvironment(testEvent({ headers: h, params: { id: 'no-such-env' } })), { ...OWN, stranger: 404, viewer: 404, editor: 404, owner: 404, admin: 404 }],
  ['GET /api/ui/environments/:id/variables', (h, i) => listVariables(testEvent({ headers: h, params: { id: i.envId } })), READ],
  ['PUT /api/ui/environments/:id/variables/:name', (h, i) => putVariable(testEvent({ headers: h, params: { id: i.envId, name: 'x' }, body: {} })), EDIT],
  ['DELETE /api/ui/environments/:id/variables/:name', (h, i) => deleteVariable(testEvent({ headers: h, params: { id: i.envId, name: 'x' } })), EDIT],
  ['POST /api/ui/environments/:id/variables/import', (h, i) => importVariables(testEvent({ headers: h, params: { id: i.envId }, body: {} })), EDIT],
  ['PUT /api/ui/environments/:id/link', (h, i) => putLink(testEvent({ headers: h, params: { id: i.envId }, body: {} })), OWN],
  ['DELETE /api/ui/environments/:id/link', (h, i) => deleteLink(testEvent({ headers: h, params: { id: i.envId } })), OWN],
  ['POST /api/ui/environments/:id/sync', (h, i) => syncNow(testEvent({ headers: h, params: { id: i.envId } })), EDIT],
  ['GET /api/ui/github/installations/:id/repositories', (h) => listRepos(testEvent({ headers: h, params: { id: '1' } })), OWNER_SOMEWHERE],
  ['GET /api/github/install', (h) => githubInstall(testEvent({ headers: h })), ADMIN],
  ['GET /api/github/setup', (h) => githubSetup(testEvent({ headers: h })), ADMIN],
  ['GET /api/ui/github', (h) => githubStatus(testEvent({ headers: h })), ANY_SESSION],
  ['POST /api/admin/retention', (h) => retention(testEvent({ headers: h })), ADMIN]
  // Token and member routes get their rows in Tasks 5 and 6.
]

describe.each(ROUTES)('%s', (_name, call, expected) => {
  it.each(Object.entries(expected) as Array<[Actor, Outcome]>)('%s → %s', async (actor, outcome) => {
    const got = await outcomeOf(call(headers[actor], ids))
    expect(got).toBe(outcome)
  })
})

describe('non-member 404', () => {
  it('is byte-identical to an unknown project id', async () => {
    const stranger = await errorOf(listVersions(testEvent({ headers: headers.stranger, params: { id: ids.projectId } })))
    const unknown = await errorOf(listVersions(testEvent({ headers: headers.viewer, params: { id: 'nope' } })))
    expect(stranger).toEqual({ statusCode: 404, statusMessage: NOT_FOUND })
    expect(unknown).toEqual(stranger)
  })
})

async function outcomeOf(call: Promise<unknown>): Promise<Outcome> {
  try {
    await call
    return 'pass'
  } catch (error) {
    if (!isApiError(error)) return 'pass'
    if (error.statusCode === 401 || error.statusCode === 403) return error.statusCode
    if (error.statusCode === 404 && error.statusMessage === NOT_FOUND) return 404
    if (error.statusCode === 404) return 404
    return 'pass'
  }
}

async function errorOf(call: Promise<unknown>): Promise<{ statusCode?: number; statusMessage?: string }> {
  try {
    await call
    return {}
  } catch (error) {
    return isApiError(error) ? { statusCode: error.statusCode, statusMessage: error.statusMessage } : {}
  }
}
```

The `DELETE /api/ui/environments/:id` row deliberately uses an unknown environment id to pin "unknown environment = 404 for everyone"; the real-environment delete is covered by `tests/ui/variables.test.ts`. If a `'pass'` actor legitimately gets a non-NOT_FOUND 404 from a route's own lookup (e.g. version blob missing → `readVersion` 404 "Stored state ... missing"), `outcomeOf` reports 404 — in that case make the seeded row complete (write a real blob via `store().put`) rather than weakening the table.

Also add these Review Focus tests to the same file:

```ts
describe('cross-project ids', () => {
  it('a viewer of project A gets 404 for an environment in project B', async () => {
    const other = await seedProject(ORG, 'other')
    const otherEnv = ulid()
    await db().insert(environment).values({ id: otherEnv, projectId: other, slug: 'dev' })
    expect(await outcomeOf(listVariables(testEvent({ headers: headers.viewer, params: { id: otherEnv } })))).toBe(404)
  })
})

describe('removed member', () => {
  it('gets 404 on every project route after removal', async () => {
    const stamp = Date.now()
    const u = await provisionUser(`rr-removed-${stamp}@example.com`, PASSWORD)
    await setRole(u.id, 'member')
    await grantProjectRole(ids.projectId, u.id, 'viewer')
    const h = Object.fromEntries((await signInHeaders(u.email, PASSWORD)).entries())
    await db().delete(projectMember).where(eq(projectMember.userId, u.id))
    for (const [, call, expected] of ROUTES) {
      if (expected.viewer === 'pass' && expected.stranger === 404) {
        expect(await outcomeOf(call(h, ids))).toBe(404)
      }
    }
  })
})
```

- [ ] **Step 2: Run, verify failure** — `pnpm vitest run tests/integration/route-roles.test.ts` → many FAILs (strangers pass, editors 403 on admin routes).

- [ ] **Step 3: Swap the guards** per the table. One file at a time; keep each route's existing behaviour after the guard unchanged.

- [ ] **Step 4: Fix sibling suites.** Run `pnpm test`. Every failure in an existing suite that drives a route with a `member` session expecting success: add `await grantProjectRole(projectId, memberId, 'viewer')` (or the role the assertion needs) in its `beforeAll`. Do not change an assertion's expected status to make it pass — if a test asserted "member gets 403 on write", it now needs the member to be a viewer to still get 403 (a stranger gets 404).

- [ ] **Step 5: Run** — `pnpm test && pnpm typecheck && pnpm lint` → PASS (S3 suites may skip without MinIO, as before).

- [ ] **Step 6: Commit**

```bash
git add server/api/ui server/api/admin/rollback.post.ts server/utils/project-access.ts tests
git commit -m "feat: enforce project roles on every project route"
```

(Stage only paths you changed; `git status` first.)

---

### Task 5: Member management

**Files:**
- Create: `server/services/members.ts`
- Create: `server/api/ui/projects/[id]/members.get.ts`, `server/api/ui/projects/[id]/members.post.ts`, `server/api/ui/projects/[id]/members/[userId].patch.ts`, `server/api/ui/projects/[id]/members/[userId].delete.ts`
- Test: `tests/integration/members.test.ts`; add rows to `tests/integration/route-roles.test.ts`

**Interfaces:**
- Consumes: `addMemberSchema`, `changeMemberRoleSchema`, `ProjectRole`; `requireProjectPermission`, `ensureAccessRecord`; `recordAuditBestEffort` (`{ orgId, projectId, actorType: 'user', actorId, action, meta }`).
- Produces:
  - `listMembers(projectId: string): Promise<Array<{ userId: string; name: string; email: string; role: ProjectRole; addedAt: Date }>>`
  - `addMember(input: { projectId: string; email: string; role: ProjectRole; actorId: string }): Promise<{ userId: string }>`
  - `changeMemberRole(input: { projectId: string; userId: string; role: ProjectRole; actorId: string }): Promise<void>`
  - `removeMember(input: { projectId: string; userId: string; actorId: string }): Promise<void>`
  - Route responses: GET → `{ members: [...], ownerCount: number }`; POST → `{ userId }`; PATCH/DELETE → `{ ok: true }`.

- [ ] **Step 1: Failing tests**

`tests/integration/members.test.ts`:

```ts
import { testEvent, isApiError } from '../ui/nitro-globals'
import { describe, it, expect, beforeAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { provisionUser, signInHeaders, setRole, resetDb, seedProject, grantProjectRole } from '../protocol/helpers'
import { db } from '../../server/db/client'
import { auditLog, projectAccess } from '../../server/db/schema'
import listMembers from '../../server/api/ui/projects/[id]/members.get'
import addMember from '../../server/api/ui/projects/[id]/members.post'
import changeRole from '../../server/api/ui/projects/[id]/members/[userId].patch'
import removeMember from '../../server/api/ui/projects/[id]/members/[userId].delete'

const ORG = 'members'
const PASSWORD = 'correct horse battery staple'
let projectId: string
const u: Record<string, { id: string; email: string; h: Record<string, string> }> = {}

beforeAll(async () => {
  await resetDb(ORG)
  projectId = await seedProject(ORG, 'p')
  const stamp = Date.now()
  for (const name of ['admin', 'owner', 'viewer', 'outsider']) {
    const p = await provisionUser(`mb-${name}-${stamp}@example.com`, PASSWORD)
    await setRole(p.id, name === 'admin' ? 'admin' : 'member')
    if (name === 'owner' || name === 'viewer') await grantProjectRole(projectId, p.id, name)
    u[name] = { ...p, h: Object.fromEntries((await signInHeaders(p.email, PASSWORD)).entries()) }
  }
})

async function status(call: Promise<unknown>): Promise<number | undefined> {
  try { await call; return undefined } catch (e) { return isApiError(e) ? e.statusCode : undefined }
}

describe('members', () => {
  it('lists members with name, email, role for any member', async () => {
    const res = await listMembers(testEvent({ headers: u.viewer.h, params: { id: projectId } }))
    expect(res.members.map((m) => m.email).toSorted()).toEqual([u.owner.email, u.viewer.email].toSorted())
    expect(res.ownerCount).toBe(1)
  })

  it('matches email case-insensitively and trims', async () => {
    await addMember(testEvent({ headers: u.owner.h, params: { id: projectId }, body: { email: `  ${u.outsider.email.toUpperCase()} `, role: 'editor' } }))
    const res = await listMembers(testEvent({ headers: u.owner.h, params: { id: projectId } }))
    expect(res.members.find((m) => m.userId === u.outsider.id)?.role).toBe('editor')
  })

  it('answers 409 for an existing member', async () => {
    expect(await status(addMember(testEvent({ headers: u.owner.h, params: { id: projectId }, body: { email: u.viewer.email, role: 'owner' } })))).toBe(409)
  })

  it('answers 404 for an unknown email', async () => {
    expect(await status(addMember(testEvent({ headers: u.owner.h, params: { id: projectId }, body: { email: 'nobody@example.com', role: 'viewer' } })))).toBe(404)
  })

  it('refuses a viewer with 403', async () => {
    expect(await status(addMember(testEvent({ headers: u.viewer.h, params: { id: projectId }, body: { email: u.admin.email, role: 'viewer' } })))).toBe(403)
  })

  it('lets an admin with no membership row manage members', async () => {
    await changeRole(testEvent({ headers: u.admin.h, params: { id: projectId, userId: u.outsider.id }, body: { role: 'viewer' } }))
    const res = await listMembers(testEvent({ headers: u.admin.h, params: { id: projectId } }))
    expect(res.members.find((m) => m.userId === u.outsider.id)?.role).toBe('viewer')
  })

  it('audits add, role change and removal', async () => {
    await removeMember(testEvent({ headers: u.owner.h, params: { id: projectId, userId: u.outsider.id } }))
    const rows = await db().select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.projectId, projectId))
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(['member.add', 'member.role', 'member.remove']))
  })

  it('answers 404 when changing or removing a non-member', async () => {
    expect(await status(changeRole(testEvent({ headers: u.owner.h, params: { id: projectId, userId: u.outsider.id }, body: { role: 'owner' } })))).toBe(404)
    expect(await status(removeMember(testEvent({ headers: u.owner.h, params: { id: projectId, userId: u.outsider.id } })))).toBe(404)
  })

  it("a demoted owner's next member write is 403", async () => {
    const p = await seedProject(ORG, 'demote')
    await grantProjectRole(p, u.owner.id, 'owner')
    await grantProjectRole(p, u.viewer.id, 'viewer')
    await changeRole(testEvent({ headers: u.owner.h, params: { id: p, userId: u.owner.id }, body: { role: 'viewer' } }))
    expect(await status(removeMember(testEvent({ headers: u.owner.h, params: { id: p, userId: u.viewer.id } })))).toBe(403)
  })

  it('allows the last owner to leave (zero owners)', async () => {
    const p = await seedProject(ORG, 'leave')
    await grantProjectRole(p, u.owner.id, 'owner')
    await removeMember(testEvent({ headers: u.owner.h, params: { id: p, userId: u.owner.id } }))
    const res = await listMembers(testEvent({ headers: u.admin.h, params: { id: p } }))
    expect(res.ownerCount).toBe(0)
  })

  it('creates a missing access record on first use', async () => {
    const p = await seedProject(ORG, 'healme')
    await db().delete(projectAccess).where(eq(projectAccess.id, p))
    await addMember(testEvent({ headers: u.admin.h, params: { id: p }, body: { email: u.viewer.email, role: 'viewer' } }))
    expect(await db().select().from(projectAccess).where(and(eq(projectAccess.id, p)))).toHaveLength(1)
  })
})
```

Add matrix rows in `route-roles.test.ts`: `GET .../members` → `READ`; `POST .../members` (body `{}`) → `OWN`; `PATCH .../members/:userId` (body `{}`) → `OWN`; `DELETE .../members/:userId` (userId `'nobody'`) → `OWN` with `owner: 404, admin: 404` (unknown member).

- [ ] **Step 2: Run, verify failure** — `pnpm vitest run tests/integration/members.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Service**

`server/services/members.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/client'
import { project, projectMember, user } from '../db/schema'
import { projectRoleSchema, type ProjectRole } from '../../shared/schemas/project-role'
import { recordAuditBestEffort } from './audit'
import { ensureAccessRecord } from '../utils/project-access'

export type MemberRow = { userId: string; name: string; email: string; role: ProjectRole; addedAt: Date }

async function orgIdOf(projectId: string): Promise<string> {
  const rows = await db().select({ orgId: project.orgId, name: project.name }).from(project).where(eq(project.id, projectId))
  const row = rows[0]
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Unknown project. Check the project id and try again.' })
  return row.orgId
}

export async function listMembers(projectId: string): Promise<MemberRow[]> {
  const rows = await db()
    .select({ userId: user.id, name: user.name, email: user.email, role: projectMember.role, addedAt: projectMember.createdAt })
    .from(projectMember)
    .innerJoin(user, eq(projectMember.userId, user.id))
    .where(eq(projectMember.organizationId, projectId))
    .orderBy(user.name)
  // A role string the schema does not recognise is not a member (least privilege).
  return rows.flatMap((r) => {
    const role = projectRoleSchema.safeParse(r.role)
    return role.success ? [{ ...r, role: role.data }] : []
  })
}

export async function addMember(input: { projectId: string; email: string; role: ProjectRole; actorId: string }): Promise<{ userId: string }> {
  const orgId = await orgIdOf(input.projectId)
  const rows = await db().select({ id: user.id, name: user.name }).from(user).where(eq(sql`lower(${user.email})`, input.email.toLowerCase()))
  const target = rows[0]
  if (!target) throw createError({ statusCode: 404, statusMessage: 'No account with that email. An admin creates accounts.' })

  const [projectRow] = await db().select({ name: project.name }).from(project).where(eq(project.id, input.projectId))
  await ensureAccessRecord(input.projectId, projectRow?.name ?? input.projectId)

  const inserted = await db()
    .insert(projectMember)
    .values({ id: ulid(), organizationId: input.projectId, userId: target.id, role: input.role })
    .onConflictDoNothing({ target: [projectMember.organizationId, projectMember.userId] })
    .returning({ id: projectMember.id })
  if (inserted.length === 0) {
    const [existing] = await db().select({ role: projectMember.role }).from(projectMember)
      .where(and(eq(projectMember.organizationId, input.projectId), eq(projectMember.userId, target.id)))
    throw createError({ statusCode: 409, statusMessage: `${input.email} is already a ${existing?.role ?? 'member'} on this project.` })
  }
  await recordAuditBestEffort({ orgId, projectId: input.projectId, actorType: 'user', actorId: input.actorId, action: 'member.add', meta: { userId: target.id, role: input.role } })
  return { userId: target.id }
}

export async function changeMemberRole(input: { projectId: string; userId: string; role: ProjectRole; actorId: string }): Promise<void> {
  const orgId = await orgIdOf(input.projectId)
  const before = await db().select({ role: projectMember.role }).from(projectMember)
    .where(and(eq(projectMember.organizationId, input.projectId), eq(projectMember.userId, input.userId)))
  if (!before[0]) throw createError({ statusCode: 404, statusMessage: 'That account is not a member of this project.' })
  await db().update(projectMember).set({ role: input.role })
    .where(and(eq(projectMember.organizationId, input.projectId), eq(projectMember.userId, input.userId)))
  await recordAuditBestEffort({ orgId, projectId: input.projectId, actorType: 'user', actorId: input.actorId, action: 'member.role', meta: { userId: input.userId, from: before[0].role, to: input.role } })
}

export async function removeMember(input: { projectId: string; userId: string; actorId: string }): Promise<void> {
  const orgId = await orgIdOf(input.projectId)
  const removed = await db().delete(projectMember)
    .where(and(eq(projectMember.organizationId, input.projectId), eq(projectMember.userId, input.userId)))
    .returning({ role: projectMember.role })
  if (!removed[0]) throw createError({ statusCode: 404, statusMessage: 'That account is not a member of this project.' })
  await recordAuditBestEffort({ orgId, projectId: input.projectId, actorType: 'user', actorId: input.actorId, action: 'member.remove', meta: { userId: input.userId, role: removed[0].role } })
}
```

`.returning(...)` with arguments: check whether the existing code avoids it for the node-pg/neon-http union (see the comment in `projects.post.ts` about "only the zero-argument overload is common to both"). If the typed overload fails, use `.returning()` with no argument and read `.length` / `[0]?.role`.

Check `recordAuditBestEffort`'s `meta` field name against `server/services/audit.ts` `AuditEntry` and match it.

- [ ] **Step 4: Routes**

Each route: `requireSession` → validate params (`z.object({ id: z.string().min(1).max(64) })`, plus `userId` for the `[userId]` routes) → `requireProjectPermission(event, id, perm)` → body → service.

- `members.get.ts`: `project:read`. Return `{ members, ownerCount: members.filter((m) => m.role === 'owner').length }`.
- `members.post.ts`: `member:manage`, body `addMemberSchema`. Return `addMember(...)`.
- `members/[userId].patch.ts`: `member:manage`, body `changeMemberRoleSchema`. Return `{ ok: true }`.
- `members/[userId].delete.ts`: `member:manage`. Return `{ ok: true }`.

- [ ] **Step 5: Run** — `pnpm vitest run tests/integration/members.test.ts tests/integration/route-roles.test.ts && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/members.ts "server/api/ui/projects/[id]/members.get.ts" "server/api/ui/projects/[id]/members.post.ts" "server/api/ui/projects/[id]/members" tests/integration/members.test.ts tests/integration/route-roles.test.ts
git commit -m "feat: let project owners manage members"
```

---

### Task 6: Tokens bounded by their creator

**Files:**
- Modify: `server/utils/tf-auth.ts`, `server/api/tf/[org]/[project]/index.ts`, `server/api/tf/[org]/[project]/lock.ts`, `server/api/vars/[org]/[project]/[environment].get.ts`
- Modify: `server/api/ui/tokens.post.ts`, `server/api/ui/tokens.get.ts`, `server/api/ui/tokens/[id].delete.ts`
- Modify: test files that mint tokens for a non-admin owner: `tests/protocol/endpoints.test.ts`, `tests/protocol/vars-delivery.test.ts`, `tests/e2e/scenario.ts`, `tests/e2e/variables.test.ts`, `tests/integration/auth.test.ts` (only if it drives tf routes) — make the owning user an admin via `setRole(userId, 'admin')` or grant `owner` on the project.
- Test: `tests/protocol/token-ceiling.test.ts` (create); add token rows to `route-roles.test.ts`

**Interfaces:**
- Consumes: `effectiveRoleOfUser`, `projectCan`, `ownsAnyProject`, `TfPrincipal` (`userId` = creator), `ResolvedProject` (`id`).
- Produces:
  - `requireCreatorAccess(principal: TfPrincipal, resolved: ResolvedProject, need: 'state:read' | 'state:write' | 'vars:read'): Promise<void>`
  - `stateNeed(action: StateAction): 'state:read' | 'state:write'` — `read` → `state:read`; `write`, `lock`, `delete` → `state:write` (R1).

Floors (spec §7): `state:read` → any role; `state:write` → `editor`+; `vars:read` → `owner`. `all`-scope tokens: creator must be deployment admin, else 403.

- [ ] **Step 1: Failing tests**

`tests/protocol/token-ceiling.test.ts`:

```ts
import { testEvent, isApiError } from '../ui/nitro-globals'
import { describe, it, expect, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { provisionUser, signInHeaders, setRole, resetDb, seedProject, grantProjectRole } from './helpers'
import { db } from '../../server/db/client'
import { projectMember, user } from '../../server/db/schema'
import { auth } from '../../server/utils/auth'
import { requireCreatorAccess, authenticateTf } from '../../server/utils/tf-auth'
import createToken from '../../server/api/ui/tokens.post'

const ORG = 'token-ceiling'
const PASSWORD = 'correct horse battery staple'
let projectId: string
let owner: { id: string; email: string; h: Record<string, string> }
let editorId: string

async function mint(userId: string, scope: object, state: string[], vars: string[] = []): Promise<string> {
  const key = await auth.api.createApiKey({
    body: { userId, name: 't', metadata: { scope }, permissions: { state, ...(vars.length ? { vars } : {}) } }
  })
  return key.key
}

async function principalFor(key: string) {
  return authenticateTf(testEvent({ headers: { authorization: `Basic ${Buffer.from(`x:${key}`).toString('base64')}` } }))
}

async function status(call: Promise<unknown>): Promise<number | undefined> {
  try { await call; return undefined } catch (e) { return isApiError(e) ? e.statusCode : undefined }
}

const resolved = () => ({ id: projectId, orgId: '', ref: { org: ORG, project: 'p' } })

beforeAll(async () => {
  await resetDb(ORG)
  projectId = await seedProject(ORG, 'p')
  const stamp = Date.now()
  const o = await provisionUser(`tc-owner-${stamp}@example.com`, PASSWORD)
  const e = await provisionUser(`tc-editor-${stamp}@example.com`, PASSWORD)
  await setRole(o.id, 'member')
  await setRole(e.id, 'member')
  await grantProjectRole(projectId, o.id, 'owner')
  await grantProjectRole(projectId, e.id, 'editor')
  owner = { ...o, h: Object.fromEntries((await signInHeaders(o.email, PASSWORD)).entries()) }
  editorId = e.id
})

describe('use-time ceiling', () => {
  it('lets an owner token write and read vars', async () => {
    const p = await principalFor(await mint(owner.id, { kind: 'projects', projects: [`${ORG}/p`] }, ['read', 'write'], ['read']))
    await expect(requireCreatorAccess(p, resolved(), 'state:write')).resolves.toBeUndefined()
    await expect(requireCreatorAccess(p, resolved(), 'vars:read')).resolves.toBeUndefined()
  })

  it('refuses vars read when the creator is only an editor', async () => {
    const p = await principalFor(await mint(editorId, { kind: 'projects', projects: [`${ORG}/p`] }, ['read'], ['read']))
    expect(await status(requireCreatorAccess(p, resolved(), 'vars:read'))).toBe(403)
    await expect(requireCreatorAccess(p, resolved(), 'state:write')).resolves.toBeUndefined()
  })

  it('stops working when the creator is demoted to viewer, and works again when restored', async () => {
    const key = await mint(editorId, { kind: 'projects', projects: [`${ORG}/p`] }, ['read', 'write'])
    await grantProjectRole(projectId, editorId, 'viewer')
    expect(await status(requireCreatorAccess(await principalFor(key), resolved(), 'state:write'))).toBe(403)
    await expect(requireCreatorAccess(await principalFor(key), resolved(), 'state:read')).resolves.toBeUndefined()
    await grantProjectRole(projectId, editorId, 'editor')
    await expect(requireCreatorAccess(await principalFor(key), resolved(), 'state:write')).resolves.toBeUndefined()
  })

  it('refuses after the creator is removed from the project', async () => {
    const stamp = Date.now()
    const x = await provisionUser(`tc-removed-${stamp}@example.com`, PASSWORD)
    await setRole(x.id, 'member')
    await grantProjectRole(projectId, x.id, 'owner')
    const key = await mint(x.id, { kind: 'projects', projects: [`${ORG}/p`] }, ['read'])
    await db().delete(projectMember).where(eq(projectMember.userId, x.id))
    expect(await status(requireCreatorAccess(await principalFor(key), resolved(), 'state:read'))).toBe(403)
  })

  it('disarms an all-scope token when its creator stops being an admin', async () => {
    const stamp = Date.now()
    const a = await provisionUser(`tc-admin-${stamp}@example.com`, PASSWORD)
    await setRole(a.id, 'admin')
    const key = await mint(a.id, { kind: 'all' }, ['read'])
    await expect(requireCreatorAccess(await principalFor(key), resolved(), 'state:read')).resolves.toBeUndefined()
    await setRole(a.id, 'member')
    await grantProjectRole(projectId, a.id, 'owner')
    expect(await status(requireCreatorAccess(await principalFor(key), resolved(), 'state:read'))).toBe(403)
  })

  it('refuses a token whose creator account was deleted', async () => {
    const stamp = Date.now()
    const x = await provisionUser(`tc-deleted-${stamp}@example.com`, PASSWORD)
    await setRole(x.id, 'member')
    await grantProjectRole(projectId, x.id, 'owner')
    const key = await mint(x.id, { kind: 'projects', projects: [`${ORG}/p`] }, ['read'])
    const before = await principalFor(key)
    await db().delete(user).where(eq(user.id, x.id))
    // The key row may cascade away with its owner (401 at authenticateTf), or
    // survive (403 here). Either refuses; neither is a 500.
    const s = await status((async () => requireCreatorAccess(await principalFor(key).catch(() => before), resolved(), 'state:read'))())
    expect([401, 403]).toContain(s)
  })
})

describe('creation rules', () => {
  it('refuses a non-admin an all-scope token', async () => {
    expect(await status(createToken(testEvent({ headers: owner.h, body: { name: 'x', actions: ['read'], scope: { kind: 'all' } } })))).toBe(403)
  })

  it('refuses a token naming a project the caller does not own', async () => {
    const other = await seedProject(ORG, 'other')
    await grantProjectRole(other, owner.id, 'editor')
    expect(await status(createToken(testEvent({ headers: owner.h, body: { name: 'x', actions: ['read'], scope: { kind: 'projects', projects: [`${ORG}/p`, `${ORG}/other`] } } })))).toBe(403)
  })

  it('lets an owner create a vars-read token for their project', async () => {
    const res = await createToken(testEvent({ headers: owner.h, body: { name: 'x', actions: [], varActions: ['read'], scope: { kind: 'projects', projects: [`${ORG}/p`] } } }))
    expect(res.key).toMatch(/^sm_/)
  })
})
```

Add `route-roles.test.ts` rows: `GET /api/ui/tokens` → `OWNER_SOMEWHERE`; `POST /api/ui/tokens` (body `{}`) → `OWNER_SOMEWHERE`; `DELETE /api/ui/tokens/:id` → `OWNER_SOMEWHERE`.

- [ ] **Step 2: Run, verify failure** — `pnpm vitest run tests/protocol/token-ceiling.test.ts` → FAIL.

- [ ] **Step 3: `requireCreatorAccess`**

In `server/utils/tf-auth.ts`:

```ts
export type CreatorNeed = 'state:read' | 'state:write' | 'vars:read'

/** R1: anything that changes state — write, lock, delete — needs editor. */
export function stateNeed(action: StateAction): CreatorNeed {
  return action === 'read' ? 'state:read' : 'state:write'
}

const FLOOR: Record<CreatorNeed, ProjectRole> = {
  'state:read': 'viewer',
  'state:write': 'editor',
  'vars:read': 'owner'
}
const RANK: Record<EffectiveRole, number> = { viewer: 0, editor: 1, owner: 2, admin: 3 }

/**
 * A token is its creator's authority, delegated (project-access spec §7). It
 * is re-checked on every request so that removing someone from a project
 * disarms their CI tokens without anyone having to find and revoke them.
 * Runs after authorizeTf / authorizeVars, which check the token's own scope
 * and actions.
 */
export async function requireCreatorAccess(
  principal: TfPrincipal,
  resolved: ResolvedProject,
  need: CreatorNeed
): Promise<void> {
  const role = await effectiveRoleOfUser(principal.userId, resolved.id)
  const allowed =
    role !== null &&
    (principal.scope.kind === 'all' ? role === 'admin' : RANK[role] >= RANK[FLOOR[need]])
  if (!allowed) {
    throw createError({
      statusCode: 403,
      statusMessage: `The account that created this token no longer has access to ${resolved.ref.org}/${resolved.ref.project}`
    })
  }
}
```

Imports: `effectiveRoleOfUser, type EffectiveRole` from `./project-access`; `type ProjectRole` from `../../shared/schemas/project-role`; `type ResolvedProject` from `./tf-handler` (check for an import cycle; if `tf-handler` imports `tf-auth`, move the `ResolvedProject` type import to `import type`, which is erased).

Update the `scopeAllows` comment: `all` means every project in the deployment, honoured only while the creator is an admin.

- [ ] **Step 4: Call sites**

- `tf/[org]/[project]/index.ts`: after `authorizeTf(principal, ref, action)` add `await requireCreatorAccess(principal, resolved, stateNeed(action))`.
- `tf/[org]/[project]/lock.ts`: after `authorizeTf(principal, ref, 'lock')` add `await requireCreatorAccess(principal, resolved, 'state:write')`.
- `vars/.../[environment].get.ts`: after `authorizeVars(principal, ref)` add `await requireCreatorAccess(principal, resolved, 'vars:read')`.

- [ ] **Step 5: Token routes**

`tokens.post.ts`:

```ts
export default defineEventHandler(async (event) => {
  const session = await requireSession(event)
  const config = await readValidatedBody(event, tokenConfigSchema.parse)
  await requireTokenAuthority(session, config.scope)
  const created = await auth.api.createApiKey({ body: toApiKeyBody(config, session.userId) })
  return { id: created.id, key: created.key, name: created.name ?? config.name }
})
```

Note the body is now read before the authority check because the check needs the scope; an anonymous caller is still 401 first. Add `requireTokenAuthority` to `server/utils/project-access.ts`:

```ts
/**
 * Token creation (spec §7): `all` is admin-only; a project list needs owner on
 * every listed project. Resolves `org/project` refs to ids; an unknown ref is
 * the same 403 as an unowned one, so token creation cannot probe for slugs.
 */
export async function requireTokenAuthority(principal: Principal, scope: TokenScope): Promise<void> {
  if (isAdmin(principal.role)) return
  const refuse = (): never => {
    throw createError({ statusCode: 403, statusMessage: 'You can only create tokens for projects you own.' })
  }
  if (scope.kind === 'all') refuse()
  if (scope.kind !== 'projects') return
  for (const ref of scope.projects) {
    const [org, slug] = ref.split('/')
    const rows = await db()
      .select({ id: project.id })
      .from(project)
      .innerJoin(organization, eq(project.orgId, organization.id))
      .where(and(eq(organization.slug, org ?? ''), eq(project.slug, slug ?? '')))
    const id = rows[0]?.id
    if (!id || (await effectiveRole(principal, id)) !== 'owner') refuse()
  }
}
```

`tokens.get.ts` and `tokens/[id].delete.ts`: replace `requireAdmin` with:

```ts
  const session = await requireSession(event)
  if (!isAdmin(session.role) && !(await ownsAnyProject(session.userId))) {
    throw createError({ statusCode: 403, statusMessage: 'Tokens are for admins and project owners. Ask a project owner.' })
  }
```

Factor that into `requireTokenPage(event)` in `project-access.ts` and use it in both, plus `github/installations/[id]/repositories.get.ts` from Task 4 if its message matches — keep each route's own message if they differ.

- [ ] **Step 6: Fix token-minting suites.** Run `pnpm test`. For each protocol/e2e suite whose tokens now 403, make the token's owning user an admin with `setRole(userId, 'admin')` in setup (they were admin-created tokens in production terms). Do not loosen `requireCreatorAccess`.

- [ ] **Step 7: Run** — `pnpm test && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 8: Commit**

```bash
git add server/utils/tf-auth.ts server/utils/project-access.ts "server/api/tf" "server/api/vars" server/api/ui/tokens.post.ts server/api/ui/tokens.get.ts "server/api/ui/tokens" "server/api/ui/github" tests
git commit -m "feat: bound tokens by their creator's project role"
```

---

### Task 7: Dashboard

**Files:**
- Create: `app/composables/useProjectRole.ts`, `app/components/ProjectOnly.vue`, `app/components/MembersPanel.vue`, `app/components/MemberAddModal.vue`, `app/components/MemberRemoveModal.vue`
- Modify: `app/pages/index.vue`, `app/pages/projects/[org]/[project]/index.vue`, `app/components/VariablesPanel.vue`, `app/components/RepositoryPanel.vue`, `app/components/LockBanner.vue`, `app/pages/tokens.vue`, `app/components/TokenConfigurator.vue`, `app/layouts/dashboard.vue`, `app/pages/users.vue`, `server/api/ui/users.get.ts`
- Test: `tests/unit/project-role-ui.test.ts` (create) for `useProjectRole`'s pure part; screenshots via Playwright MCP.

**Interfaces:**
- Consumes: `myRole` on `/api/ui/projects` rows; member routes from Task 5; `projectCan`'s table — the UI needs it without server imports, so move `projectStatements`/roles into `shared/project-permissions.ts` **only if** `better-auth/plugins/access` is importable client-side (it is a plain module with no server deps — verify by building). Otherwise export from `shared/` a plain `const PROJECT_PERMISSION_MIN_ROLE: Record<ProjectPermission, ProjectRole>` and add a unit test asserting it agrees with `minimumRoleFor` for every permission.
- Produces: `useProjectRole(role: Ref<EffectiveRole | null | undefined>)` → `{ can: (p: ProjectPermission) => boolean }`; `<ProjectOnly :role="myRole" permission="variable:write">` renders its slot or nothing.

Plan for the shared table (preferred, no client import of better-auth): create `shared/project-permissions.ts`:

```ts
import type { ProjectRole } from './schemas/project-role'

export type ProjectPermission =
  | 'project:read' | 'project:rollback' | 'project:unlock'
  | 'environment:create' | 'environment:delete' | 'environment:link' | 'environment:sync'
  | 'variable:write' | 'member:manage' | 'token:create'
export type EffectiveRole = ProjectRole | 'admin'

/** For the UI's show/hide only. The server's role objects are the authority. */
export const MIN_ROLE: Record<ProjectPermission, ProjectRole> = {
  'project:read': 'viewer',
  'project:unlock': 'editor',
  'environment:sync': 'editor',
  'variable:write': 'editor',
  'project:rollback': 'owner',
  'environment:create': 'owner',
  'environment:delete': 'owner',
  'environment:link': 'owner',
  'member:manage': 'owner',
  'token:create': 'owner'
}

const RANK: Record<EffectiveRole, number> = { viewer: 0, editor: 1, owner: 2, admin: 3 }

export function roleAllows(role: EffectiveRole | null | undefined, permission: ProjectPermission): boolean {
  return role != null && RANK[role] >= RANK[MIN_ROLE[permission]]
}
```

Move the `ProjectPermission` and `EffectiveRole` type definitions here and re-export them from `server/utils/project-access.ts` (`export type { ProjectPermission, EffectiveRole } from '../../shared/project-permissions'`) so Tasks 2–6 imports keep working.

- [ ] **Step 1: Failing unit test**

`tests/unit/project-role-ui.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MIN_ROLE, roleAllows, type ProjectPermission } from '../../shared/project-permissions'
import { minimumRoleFor, projectCan } from '../../server/utils/project-access'

const ALL = Object.keys(MIN_ROLE) as ProjectPermission[]

describe('UI permission table', () => {
  it.each(ALL)('%s agrees with the server role objects', (permission) => {
    expect(MIN_ROLE[permission]).toBe(minimumRoleFor(permission))
    for (const role of ['viewer', 'editor', 'owner', 'admin'] as const) {
      expect(roleAllows(role, permission)).toBe(projectCan(role, permission))
    }
  })

  it('allows nothing without a role', () => {
    expect(ALL.some((p) => roleAllows(null, p))).toBe(false)
  })
})
```

(`Object.keys(...) as ProjectPermission[]` is the one cast; it is a test over a literal record. If oxlint flags it, iterate `Object.entries(MIN_ROLE)` instead.)

- [ ] **Step 2: Run, verify failure; implement `shared/project-permissions.ts`; run, pass.**

- [ ] **Step 3: Components and pages**

`app/components/ProjectOnly.vue`:

```vue
<script setup lang="ts">
/**
 * Renders its slot when the caller's project role allows `permission`, and
 * nothing otherwise — the project-level twin of AdminOnly's `quiet` mode.
 * Not the enforcement: every route behind it checks server-side.
 */
import { roleAllows, type EffectiveRole, type ProjectPermission } from '~~/shared/project-permissions'

const props = defineProps<{ role: EffectiveRole | null | undefined; permission: ProjectPermission }>()
const allowed = computed(() => roleAllows(props.role, props.permission))
</script>

<template>
  <slot v-if="allowed" />
</template>
```

Then, file by file:
- `projects/[org]/[project]/index.vue`: `const myRole = computed(() => current.value?.myRole ?? null)`. Replace `isAdmin` on the rollback button (line ~280) with `roleAllows(myRole, 'project:rollback')`. Pass `:role="myRole"` to `VariablesPanel`, `RepositoryPanel`, `LockBanner`. Add a "Members" tab (follow how the page already switches between its existing sections — read the template first and use the same `UTabs` / section pattern) rendering `<MembersPanel :project-id="current.id" :role="myRole" />`. Show the role as a `UBadge` next to the project title.
- `VariablesPanel.vue`: add prop `role`; every `isAdmin` / `<AdminOnly quiet>` becomes `roleAllows(role, 'variable:write')` / `<ProjectOnly :role="role" permission="variable:write">`, except environment create/delete → `environment:create` / `environment:delete`.
- `RepositoryPanel.vue`: prop `role`; link/unlink controls → `environment:link`; sync → `environment:sync`; the `v-if="github?.configured && (link || isAdmin)"` becomes `(link || roleAllows(role, 'environment:link'))`. GitHub App **connect** stays `isAdmin` (deployment-wide).
- `LockBanner.vue`: prop `role`; force-unlock → `project:unlock`.
- `index.vue`: role badge per row (`row.myRole`). Keep "New project" `isAdmin`. Empty state for a non-admin with zero projects: `<EmptyState icon="i-lucide-folder-lock" title="No projects yet" description="You haven't been added to any projects yet. Ask a project owner or an admin." />`.
- `MembersPanel.vue`: `useFetch(() => \`/api/ui/projects/${props.projectId}/members\`)`; `UTable` with name, email, role, added. For `member:manage`: a `USelect` per row (PATCH on change, refresh), a remove button opening `MemberRemoveModal` (a `useOverlay` modal like the existing modals; when removing the last owner — `ownerCount === 1 && row.role === 'owner'` — its body says "This project will have no owners. Only an admin can manage its members after this."), and an "Add member" button opening `MemberAddModal` (email + role form, zod `addMemberSchema`, show the server's `statusMessage` on 404/409 via `statusMessageOf`, the util the other modals use).
- `tokens.vue` + `dashboard.vue`: the Tokens nav entry and page show when `isAdmin || ownsAnyProject`. Compute `ownsAnyProject` from `/api/ui/projects` (`some((p) => p.myRole === 'owner')`) in `useAuth` or a small composable — reuse the same `useFetch('/api/ui/projects')` key the pages already use. Replace `<AdminOnly what="Managing tokens">` with an equivalent gate and message "Tokens are for admins and project owners."
- `TokenConfigurator.vue`: the project picker lists only projects where `myRole === 'owner' || myRole === 'admin'`; the "All projects" scope option renders only for admins.
- `users.vue` + `users.get.ts`: add `projects: Array<{ org: string; slug: string; role: ProjectRole }>` per account (left join `projectMember` → `project` → `organization`, grouped in JS). Column "Projects" shows the count; a `UPopover` lists `org/slug · role`. Update `tests/integration/users-service.test.ts`'s exact-keys assertion (`['createdAt','email','id','name','role']`) to include `projects` if `listAccounts` is where you add it.

- [ ] **Step 4: Verify in the browser**

Start dev (`pnpm dev`), sign in as each of admin / owner / editor / viewer / stranger (create with `pnpm user:create`, grant roles through the Members tab as admin). Using the Playwright MCP tools, screenshot:
1. Project list for stranger (empty state) and viewer (badge).
2. Project page as viewer (no write controls), editor (variable edit, unlock, sync; no env create, no rollback, no member controls), owner (everything + Members controls).
3. Members tab: add-member modal open, a 409 error shown, remove-last-owner warning modal open, then Esc closes it.
4. Tokens page as owner: project picker shows owned projects only; no "All projects".
5. Users page Projects popover open.

Check the right edge and the bottom of each table/modal in every screenshot; state what was checked.

- [ ] **Step 5: Run** — `pnpm test && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/project-permissions.ts server/utils/project-access.ts app tests/unit/project-role-ui.test.ts server/api/ui/users.get.ts server/services/users.ts tests/integration/users-service.test.ts
git commit -m "feat: show project roles and a members tab in the dashboard"
```

---

### Task 8: Manual

**Files:**
- Modify: `README.md` (section "Roles, and what every account can still read", ~lines 150–190; any other line claiming every account reads every project — `grep -n "every project" README.md docs/*.md`)
- Modify: `docs/backend-config.md` (token creation and scope)
- Check: `docs/deploy-docker.md`, `docs/deploy-vercel.md`, `docs/github-app.md` for stale "admin only" / "every account" claims about project-scoped actions.

- [ ] **Step 1: Rewrite the README section** as "Roles and project access":
  - Two levels: deployment admin vs. account; project roles viewer / editor / owner.
  - The spec §3 table verbatim (same columns).
  - Remove the blockquote telling operators to run a second deployment for partial access; replace with: "An account sees only projects it has a role on. Admins see every project."
  - "Adding people": admin creates the account (`pnpm user:create`), an owner or admin adds it on the project's Members tab by email.
  - "Upgrading": "Existing member accounts become viewers on every existing project, so nobody loses access. Narrow it from each project's Members tab."
  - Tokens paragraph: owners create tokens for their projects; `all` is admin-only; a token stops working on a project when its creator loses the role it needs (read: any role; write/lock: editor; variables: owner), and works again if the role is restored.
- [ ] **Step 2: `docs/backend-config.md`**: same token rules where tokens are created/scoped.
- [ ] **Step 3: Grep the other docs** and fix stale claims.
- [ ] **Step 4: Format and commit**

```bash
pnpm format
git add README.md docs/backend-config.md docs/deploy-docker.md docs/deploy-vercel.md docs/github-app.md
git commit -m "docs: document project roles and token ceilings"
```

(Only stage the docs you changed.)

---

## Self-review notes

- Spec coverage: §3 roles → Tasks 1–2; §4 data model + self-heal → Tasks 1, 2, 3, 5; §5 migration → Task 1; §6 guard, inventory, 404 equivalence, member management, plugin endpoints blocked, audit → Tasks 1, 2, 4, 5; §7 tokens → Task 6; §8 dashboard → Task 7; §9 errors → Global Constraints + tests in 2/4/5/6; §10 testing → each task; §11 docs → Task 8.
- Type names used across tasks: `ProjectRole`, `EffectiveRole`, `ProjectPermission`, `projectCan`, `minimumRoleFor`, `effectiveRole`, `effectiveRoleOfUser`, `requireProjectPermission`, `projectIdOfEnvironment`, `projectIdOfVersion`, `ensureAccessRecord`, `ownsAnyProject`, `requireTokenAuthority`, `requireCreatorAccess`, `stateNeed`, `grantProjectRole`, `NOT_FOUND`, `roleAllows`, `MIN_ROLE`.
