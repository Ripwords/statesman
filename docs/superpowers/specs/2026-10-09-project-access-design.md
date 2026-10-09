# statesman project access — Design Spec

**Date:** 2026-10-09
**Status:** Draft, awaiting review.

Per-project membership and roles, so one deployment can be shared across an
organization without every account reading every project's decrypted state.

This builds on the original design
([2026-09-04-statesman-design.md](2026-09-04-statesman-design.md), "base §N")
and the variables design
([2026-10-09-variables-design.md](2026-10-09-variables-design.md), "vars §N").

---

## 1. Problem

Today a deployment has two roles, `admin` and `member`, and they govern only
who may _change_ things. Every account reads every project: decrypted state,
version history, diffs, environments, non-sensitive variable values. The README
tells operators to run a second deployment if some people should see only some
projects.

That defeats the point of a shared state backend. A platform team cannot give a
product team access to its own project without also handing over the
production database passwords sitting in every other project's state.

### Goals

- Two levels, no more: a **deployment admin** (Better Auth admin plugin, as
  today) and a **role per project** (Better Auth organization plugin).
- An account with no role on a project cannot see that it exists.
- Project owners manage their own project's members without an admin.
- Tokens can never do more than the account that created them can do now.
- Upgrading an existing deployment loses nobody's access.

### Non-goals

- **An organization layer between deployment and project.** A deployment is
  one organization. The `:org` URL segment stays the fixed deployment slug.
  Teams that need hard separation still run separate deployments.
- **Teams or groups.** Membership is per account, per project.
- **Invitations by email.** statesman has no mail transport. Owners add
  accounts that already exist, by exact email address.
- **Self-service sign-up.** Accounts are still created by an operator
  (`pnpm user:create`).
- **Export / download of `.tfvars` or state from the dashboard.** Useful and
  small, but a separate change (§12, D6).
- **Revealing sensitive variables in the dashboard.** vars §7 stands: write-only
  for every role.

---

## 2. Concepts

| Term              | Meaning                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Deployment admin  | `user.role = 'admin'` (admin plugin). Sees and manages every project, with or without a membership row.                  |
| Account           | `user.role = 'member'`. Sees only projects it holds a project role on.                                                   |
| Project role      | `viewer`, `editor` or `owner`, stored as an organization-plugin `member` row whose organization is the project.         |
| Access record     | The organization-plugin `organization` row backing one project. 1:1 with `project`, same id. Holds no product data.     |

"Organization" in Better Auth's API means **project** in this spec. The
existing statesman `organization` table (the deployment slug) is unrelated and
unchanged.

---

## 3. Roles

|                                                         | viewer | editor | owner | deployment admin |
| ------------------------------------------------------- | ------ | ------ | ----- | ---------------- |
| See the project in the list, read state, versions, diff | yes    | yes    | yes   | yes (all)        |
| See environments, variable names, statuses              | yes    | yes    | yes   | yes              |
| See non-sensitive values                                | yes    | yes    | yes   | yes              |
| See sensitive values                                    | no     | no     | no    | no               |
| Create, edit, delete, import variables                  | no     | yes    | yes   | yes              |
| Sync a linked repository                                | no     | yes    | yes   | yes              |
| Force unlock                                            | no     | yes    | yes   | yes              |
| Create, delete environments                             | no     | no     | yes   | yes              |
| Link / unlink a repository                              | no     | no     | yes   | yes              |
| Roll back                                               | no     | no     | yes   | yes              |
| Add, remove members, change their roles                 | no     | no     | yes   | yes              |
| Create tokens scoped to this project                    | no     | no     | yes   | yes              |
| Create projects                                         | —      | —      | —     | yes              |
| Tokens with `all` scope                                 | —      | —      | —     | yes              |
| Manage accounts, deployment roles, passwords            | —      | —      | —     | yes              |
| Connect the GitHub App, run retention                   | —      | —      | —     | yes              |

Roles are declared once with `createAccessControl` against these statements:

```ts
const projectAc = createAccessControl({
  project: ['read', 'rollback', 'unlock'],
  environment: ['create', 'delete', 'link', 'sync'],
  variable: ['write'],
  member: ['manage'],
  token: ['create']
})
```

`viewer`, `editor` and `owner` are `projectAc.newRole(...)` per the table.
Every authorization decision in the app goes through one function (§6), which
consults these role objects. No route compares role strings.

A deployment admin needs no membership row; they pass every project check. An
admin may still hold one (e.g. to appear in a member list) and it changes
nothing for them.

---

## 4. Data model

The organization plugin is added to `server/utils/auth.ts` with its tables
renamed, because `organization` is already taken:

```ts
organization({
  ac: projectAc,
  roles: { viewer, editor, owner },
  creatorRole: 'owner',
  allowUserToCreateOrganization: false, // projects are created by admins via /api/ui/projects
  schema: {
    organization: { modelName: 'projectAccess' },
    member: { modelName: 'projectMember' },
    invitation: { modelName: 'projectInvitation' }
  }
})
```

New tables (Drizzle, migration generated with drizzle-kit):

- `project_access` — the plugin's organization row. `id` = `project.id`
  (FK, `on delete cascade`), `name`, `slug` (globally unique; set to the
  project id), `logo`, `metadata`, `created_at`.
- `project_member` — `id`, `organization_id` → `project_access.id`
  (cascade), `user_id` → `user.id` (cascade), `role`, `created_at`. Unique on
  `(organization_id, user_id)`.
- `project_invitation` — required by the plugin's schema; unused.
- `session.active_organization_id` — nullable column the plugin adds;
  unused (§6).

**Creating a project** inserts `project`, then `project_access` with the same
id. There is no interactive transaction on neon-http, so the order matters: a
crash between the two leaves a project with no access record, which no
non-admin can see and which an admin can still open. The project page's member
panel creates the missing access record on first use (idempotent upsert), so
the state self-heals rather than needing a repair script.

The creating admin is **not** auto-added as owner (`creatorRole` only applies
to the plugin's own create endpoint, which we do not expose). They already see
everything.

---

## 5. Migration of an existing deployment

One SQL migration, after the tables exist:

1. Insert a `project_access` row for every existing `project`.
2. Insert a `project_member` row with role **`viewer`** for every
   `(project, user)` pair where `user.role` is not `admin`.

That reproduces today's visibility exactly: members could read everything and
change nothing, and they still can. Admins need no rows. Operators then narrow
access from there. The upgrade note in the README says so in one line.

Tokens: every existing token was created by an admin (only admins could), so
§7's ceiling does not narrow any of them unless that admin is later demoted.

---

## 6. Authorization

One server function decides every project-level question:

```ts
type ProjectRole = 'viewer' | 'editor' | 'owner'
type Actor = { userId: string; deploymentRole: UserRole }

/** null = no access to the project at all */
async function projectRoleOf(actor: Actor, projectId: string): Promise<ProjectRole | 'admin' | null>

function projectCan(role: ProjectRole | 'admin', permission: ProjectPermission): boolean
```

`projectRoleOf` is one indexed lookup on `project_member (organization_id,
user_id)`. It does **not** use the plugin's "active organization": URLs already
name the project, and an active-org session value would let one tab's
navigation change another tab's authority.

`projectCan` calls the role object's `authorize()` from §3, with `'admin'`
always true.

### UI routes

A new guard replaces `requireAdmin` / bare `requireSession` on every
project-scoped `/api/ui` route:

```ts
requireProjectPermission(event, projectId, permission): Promise<Principal & { projectRole }>
```

- No session → **401** (unchanged).
- Session, no role on the project → **404**, the same response as a project
  that does not exist. A non-member must not learn which slugs are taken.
- Role, but permission missing → **403** with a message naming the role
  needed ("Needs editor access to this project. Ask a project owner.").

Routes keyed by environment, version or variable resolve their project first,
then call the guard. That resolution must not leak existence: an unknown id
and an id in a project you cannot see both answer 404.

`GET /api/ui/projects` filters to projects the caller has a role on (all, for
an admin) and returns `myRole` per project so the UI can hide controls.

### Route inventory

Every route below changes. Nothing else under `/api/ui` is project-scoped.

| Route                                                       | Today          | After                         |
| ----------------------------------------------------------- | -------------- | ----------------------------- |
| `GET  /api/ui/projects`                                     | session        | session, filtered             |
| `POST /api/ui/projects`                                     | admin          | admin (unchanged)             |
| `GET  /api/ui/projects/:id/versions`                        | session        | `project:read`                |
| `GET  /api/ui/versions/:id`                                 | session        | `project:read` of its project |
| `DELETE /api/ui/projects/:id/lock`                          | admin          | `project:unlock`              |
| `POST /api/admin/rollback`                                  | admin          | `project:rollback`            |
| `GET  /api/ui/projects/:id/environments`                    | session        | `project:read`                |
| `POST /api/ui/projects/:id/environments`                    | admin          | `environment:create`          |
| `DELETE /api/ui/environments/:id`                           | admin          | `environment:delete`          |
| `GET  /api/ui/environments/:id/variables`                   | session        | `project:read`                |
| `PUT/DELETE /api/ui/environments/:id/variables/:name`       | admin          | `variable:write`              |
| `POST /api/ui/environments/:id/variables/import`            | admin          | `variable:write`              |
| `PUT/DELETE /api/ui/environments/:id/link`                  | admin          | `environment:link`            |
| `POST /api/ui/environments/:id/sync`                        | admin          | `environment:sync`            |
| `GET  /api/ui/github/installations/:id/repositories`        | admin          | owner of ≥1 project, or admin |
| `GET/POST /api/ui/tokens`, `DELETE /api/ui/tokens/:id`      | admin          | §7                            |
| new: `GET /api/ui/projects/:id/members`                     | —              | `project:read`                |
| new: `POST /api/ui/projects/:id/members`                    | —              | `member:manage`               |
| new: `PATCH/DELETE /api/ui/projects/:id/members/:userId`    | —              | `member:manage`               |

Deployment-wide routes (`users`, `retention`, GitHub install/setup) stay
`requireAdmin`.

### Member management

- **Add:** body `{ email, role }`. Exact, case-insensitive email match against
  existing accounts. Unknown email → 404 "No account with that email. An admin
  creates accounts." Already a member → 409. Adding a deployment admin is
  allowed and harmless.
- **List:** name, email, role, added-at. Visible to every project member so
  people can see who to ask. Emails are shown here because a member list
  without them cannot be acted on; it is scoped to people already sharing
  the project.
- **Change role / remove:** owners and admins. An owner may remove or demote
  themselves. A project may end with zero owners — deployment admins can
  always recover it — and the UI warns before the last owner leaves.
- Writes go through the plugin's adapter (`getOrgAdapter`) after our guard
  has authorized the caller, not through the plugin's HTTP endpoints, whose
  checks assume the caller is a member and would refuse a deployment admin who
  is not. The plugin's own organization/member HTTP endpoints are not reachable
  from the browser: `/api/auth/organization/*` answers 404 (blocked in the
  catch-all auth route), so the only door is ours.
- Every add, role change and removal writes an audit row
  (`member.add`, `member.role`, `member.remove`) with actor, target and roles.

---

## 7. Tokens

A token is a delegation of its creator's authority, so it is bounded by it
twice:

**At creation**

- `all` scope: deployment admins only.
- `projects` scope: the creator must be `owner` (or admin) on **every** listed
  project.
- `vars: read`: allowed under the same rule. (Today admin-only; an owner can
  already write those secrets, so reading them back via an audited token adds
  no new power.)

**At use** (`authenticateTf` / `authorizeTf` / `authorizeVars`)

After the existing scope and action checks, the token's creator
(`referenceId`) must still hold, on the target project:

| Token action           | Creator needs              |
| ---------------------- | -------------------------- |
| state `read`           | any role                   |
| state `write`, `lock`  | `editor` or above          |
| vars `read`            | `owner`                    |

Otherwise **403** "The account that created this token no longer has access
to {org}/{project}". Demoting or removing someone therefore disarms their
tokens immediately, without revoking them, and restoring the role re-arms
them. `all`-scope tokens are honored only while their creator is still a
deployment admin.

This is one extra indexed query per Terraform request, on top of the
`verifyApiKey` lookup that already happens.

**Token list:** an admin sees every token (as today). An owner sees and can
revoke the tokens they created. Nobody else sees the tokens page.

---

## 8. Dashboard

- **Project list** shows only visible projects, each with the caller's role as
  a badge. A non-admin with no projects sees an empty state: "You haven't been
  added to any projects yet. Ask a project owner or an admin."
- **Project page** gains a **Members** tab: table of name, email, role; owners
  get an add form (email + role select), a role select per row and a remove
  button behind the app's confirm modal (no `window.confirm`).
- Controls a role cannot use are not rendered (not just disabled), matching
  how admin-only controls are handled today. The server check is the
  authority; the UI hiding is courtesy.
- **Users page** (admins) gains a per-account "Projects" column: count, with
  the list in a popover.

---

## 9. Errors

| Condition                                       | Status | Message                                                        |
| ----------------------------------------------- | ------ | -------------------------------------------------------------- |
| No role on project (any project-scoped route)   | 404    | same body as "project not found"                               |
| Role too low                                    | 403    | `Needs {role} access to this project. Ask a project owner.`    |
| Add member, unknown email                       | 404    | `No account with that email. An admin creates accounts.`       |
| Add member, already a member                    | 409    | `{email} is already a {role} on this project.`                 |
| Token creator lost access                       | 403    | `The account that created this token no longer has access…`    |
| Token for a project the creator does not own    | 403    | `You can only create tokens for projects you own.`             |

---

## 10. Testing

TDD per task. Integration tests against the real database, as existing suites
do, each owning only the rows it creates.

- **Matrix test**: for each route in §6's inventory × {anonymous, non-member,
  viewer, editor, owner, admin}, assert the status. One table-driven file so a
  new route without a row is obvious in review.
- Non-member and unknown-id responses are byte-identical (status and body).
- Project list filtering and `myRole`.
- Member add/list/role/remove, including unknown email, duplicate, last-owner
  self-removal, admin acting without a membership row.
- `/api/auth/organization/*` answers 404.
- Tokens: creation refused for a non-owned project and for `all` by a
  non-admin; a token stops working when its creator is demoted below the
  action's floor or removed, and works again when restored; `all` token
  disarmed by admin demotion.
- Migration: on a database seeded with the pre-change schema, one admin, two
  members and two projects, after migrating each member is viewer on both
  projects and the admin has no rows.
- Project creation leaves both `project` and `project_access`; a project with a
  missing access record is still visible to an admin and gains one on first
  member-panel use.
- UI: Members tab per role (owner sees controls, viewer does not), empty-state
  project list. Screenshot each toggled state.

---

## 11. Documentation

Same change, per the repo's rules:

- README "Roles, and what every account can still read" is rewritten around
  §3's table; the "run a second deployment" warning is replaced by the
  project-role model, and the upgrade note from §5 is added.
- `docs/backend-config.md`: token creation now requires project ownership;
  tokens follow their creator's access.
- `docs/deploy-docker.md` / `deploy-vercel.md`: nothing changes for operators
  beyond running migrations; confirm no stale claims.

---

## 12. Decisions for the reviewer

- **D1. Two levels, project = Better Auth organization.** Chosen over adding a
  separate org layer (deployment already is the org) and over a hand-rolled
  membership table (the plugin gives roles, access control and member storage).
- **D2. Non-members get 404, not 403.** Hides which projects exist. Cost: a
  mistyped permission looks like a missing project in logs; mitigated because
  the guard logs the real reason server-side.
- **D3. Existing members migrate to `viewer` on every project.** Preserves
  today's access exactly. Alternative: migrate to nothing and make admins
  grant access — safer but locks everyone out on upgrade.
- **D4. Tokens are re-checked against the creator's current role on every
  request.** Alternative: check only at creation. Rejected: removing someone
  from a project would leave their CI tokens working.
- **D5. Owners add members by exact email; no account directory for owners.**
  Keeps the full account list (PII) admin-only.
- **D6. Export is out of scope.** A "Download .tfvars" (non-sensitive only, or
  owner-only with sensitive values and an audit row) and "Download state"
  button is a follow-up spec once roles exist to gate it.
- **D7. Zero owners allowed.** Admins can always recover a project, so a
  last-owner lock would only block people leaving.
