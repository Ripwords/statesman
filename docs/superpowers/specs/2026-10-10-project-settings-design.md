# statesman project settings and account creation — Design Spec

**Date:** 2026-10-10
**Status:** Approved in conversation; written for review.

Project configuration (rename, description, archive, delete, retention, a
permanent backend snippet) and creating accounts from the dashboard.

Builds on [2026-09-04-statesman-design.md](2026-09-04-statesman-design.md)
("base §N") and
[2026-10-09-project-access-design.md](2026-10-09-project-access-design.md)
("access §N").

---

## 1. Problem

1. A project can be created and nothing else. There is no way to change its
   name, describe it, retire it, or remove it, and the backend block is shown
   only once, at creation.
2. An admin on a hosted deployment cannot create accounts. `pnpm user:create`
   needs database access from a shell; the dashboard has no equivalent. Adding
   a member with a new email fails with "No account with that email. An admin
   creates accounts." — and the admin reading it has no way to act on it.

### Goals

- Owners rename and describe their projects.
- Admins archive (read-only, hidden), unarchive, and delete projects, and set a
  per-project retention override.
- Every role can see the backend block for a project they can see.
- Admins create accounts from the Users page.

### Non-goals

- **Changing a slug.** The slug is in every backend `address`, in token scopes
  stored as `"org/slug"` strings, and in blob keys (`org/slug/<id>.tfstate.enc`)
  that the orphan sweep lists by prefix. Changing it is a migration across all
  three plus every Terraform config that uses it. The slug stays immutable.
- Email invitations. There is still no mail transport (access §1).
- Restoring a deleted project. Delete is permanent.

---

## 2. Data model

One migration adds nullable columns to `project`:

| column                    | type        | meaning                                    |
| ------------------------- | ----------- | ------------------------------------------ |
| `description`             | `text`      | free text, at most 500 characters          |
| `archived_at`             | `timestamp` | null = active                              |
| `retention_keep_versions` | `integer`   | null = deployment's `RETENTION_KEEP_VERSIONS` |
| `retention_keep_days`     | `integer`   | null = deployment's `RETENTION_KEEP_DAYS`  |

Columns on `project`, not a settings table: every read already selects from
`project`, and a second table would add a join for four values.

`name` already exists (set equal to the slug at creation) and becomes editable.
Who archived a project, and when it was unarchived, live in the audit log.

---

## 3. Permissions

| action                                   | viewer | editor | owner | admin |
| ---------------------------------------- | ------ | ------ | ----- | ----- |
| See Settings tab, backend block, retention | yes  | yes    | yes   | yes   |
| Edit name and description                | no     | no     | yes   | yes   |
| Set retention override                   | no     | no     | no    | yes   |
| Archive, unarchive                       | no     | no     | no    | yes   |
| Delete (archived projects only)          | no     | no     | no    | yes   |
| Create accounts                          | —      | —      | —     | yes   |

`project:update` joins `projectStatements` (owner) and `MIN_ROLE`. The
admin-only actions use `requireAdmin`, as project creation does; they are
deployment powers, not project roles.

Retention is admin-only because lowering it permanently destroys history at
the next retention pass — the same class of action as delete.

---

## 4. API

All bodies are Zod schemas in `shared/schemas/project.ts` / `user.ts`.

### `PATCH /api/ui/projects/:id`

Body `{ name?, description?, retentionKeepVersions?, retentionKeepDays? }`.
`name` is 1–64 characters, trimmed. `description` is at most 500 characters;
an empty string stores null. Retention fields are positive integers or null
(null restores the default).

Guard: `project:update`. If any retention field is present, the caller must
also be an admin, or 403 "Only an admin can change retention." Updating name
also updates `project_access.name` so the plugin's copy does not drift.
Audit `project.update` with the changed field names (not values).

Allowed on an archived project: renaming a retired project is harmless.

### `POST /api/ui/projects/:id/archive` and `/unarchive`

Admin only. Idempotent: archiving an archived project is 200 and no audit row.
Archiving a project whose state lock is held is 409 "The state is locked. Let
the run finish or force-unlock it, then archive." Audit `project.archive` /
`project.unarchive`.

### `DELETE /api/ui/projects/:id`

Admin only. 409 "Archive the project before deleting it." unless archived.

Order: list every blob under `org/slug/` and delete them, then delete the
`project` row, which cascades to versions, pointer, lock, environments,
variables, links, access row and members.

Blobs first because an archived project cannot be written (§5), so nothing adds
a blob during the delete, and a crash part-way leaves an archived project whose
retry finishes the job. Rows first would leave encrypted blobs no sweep ever
visits (the sweep iterates projects), which a later project with the same slug
would then inherit under its prefix.

Audit `project.delete` with `{ org, project, versions }` before the row goes.
`audit_log` has no FK, so the record survives.

### `POST /api/ui/users`

Admin only. Body `{ email, name?, role: 'admin' | 'member' }`. Generates a
password (`randomBytes(18).toString('base64url')`, as the CLI and reset do),
creates the account through `auth.api.createUser` (admin plugin, which checks
the caller's admin session itself), and returns `{ id, email, password }` once.
Duplicate email is 409 "An account with that email already exists." Audit
`user.create`.

### Members 404

`addMember`'s message becomes "No account with that email. An admin creates
accounts on the Users page." The add-member modal, for an admin caller, shows a
link to `/users` with that error.

---

## 5. Archived projects

An archived project is read-only for state and configuration, and hidden.

**Terraform (`/api/tf`)**: `GET` state works. `POST` state, `DELETE` state and
lock acquisition answer **409** "Project <org>/<slug> is archived. An admin can
unarchive it." Not 423: Terraform reads 423 as "lock held" and prints holder
info that does not exist. Unlock still works so a stuck lock can be cleared.

`resolveProject` returns `archived: boolean`; the handlers check it.

**Variables delivery (`/api/vars`)**: unchanged; reading is allowed.

**Dashboard**: `requireProjectPermission` refuses with the same 409 when the
project is archived and the permission is not in
`ARCHIVED_ALLOWED = { project:read, project:unlock, project:update,
variable:download, member:manage }`. That blocks rollback, environment
create/delete/link/sync and variable writes in one place. Token creation naming
an archived project is 409 in `requireTokenAuthority`.

**Retention** still runs on archived projects.

**List**: `GET /api/ui/projects` returns `archived`, `name`, `description`. The
dashboard hides archived rows behind a **Show archived** switch (rendered only
when at least one archived project exists).

---

## 6. Retention override

`runRetention` reads the project's two columns and falls back to `env()` for
each null. A pure `effectiveRetention(project, env)` is unit-tested; the
Settings tab shows each value with "default" or "this project".

---

## 7. UI

**Project page**: a fourth tab, **Settings**, in the existing `?tab=` scheme.

- **General** — name and description. Owners and admins get a form with Save;
  others see text.
- **Backend configuration** — the block from `app/utils/backend.ts`, with a
  copy button.
- **Retention** — effective values with their source. Admins edit; a blank
  field means "use the default".
- **Danger zone** (admins only) — Archive / Unarchive, and Delete (disabled
  with an explanation until archived). Each opens a `UModal`; Delete requires
  typing `org/slug` exactly. Esc closes both.

Header shows `name`; when it differs from the slug, `org/slug` sits under it in
monospace. Archived projects show an "Archived" badge and a banner explaining
what is refused. The project list shows name, slug, description and badge.

After delete, navigate to `/` with a notice.

**Users page**: **New User** (admins) opens a modal with email, name, role;
success opens the existing `PasswordRevealModal` with the generated password.

---

## 8. Testing

TDD, vitest, existing integration harness:

- Permission matrix for PATCH (owner vs editor vs admin, retention field as
  owner → 403), archive/unarchive/delete (non-admin → 403), create user.
- Archived: every refused dashboard route → 409; tf POST, DELETE, lock → 409;
  tf GET and vars GET still 200; unlock still works.
- Archive while locked → 409. Delete while active → 409.
- Delete removes blobs and rows; a retry after a simulated blob-delete failure
  completes; audit row survives.
- `effectiveRetention` fallbacks; `runRetention` honours an override.
- Create user: generated password signs in; duplicate → 409.
- Rendered check: screenshot each Settings tab state (viewer, owner, admin,
  archived), both modals, Users modal and reveal; check Esc on each.

## 9. Documentation

README: a **Project settings** section (rename, archive, delete, retention,
backend block), new rows in the roles table, **Adding people** step 1 gains the
Users page path alongside the CLI, and an operational note that delete is
permanent and removes the encrypted blobs.
