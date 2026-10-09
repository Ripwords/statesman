# statesman variables — Design Spec

**Date:** 2026-10-09
**Status:** Draft, awaiting review.

Encrypted storage and delivery of Terraform input variables (the contents of a
`.tfvars` file), per project and environment, with optional GitHub App
discovery of which variables a repository declares.

This builds on the original design
([2026-09-04-statesman-design.md](2026-09-04-statesman-design.md)); section
references of the form "base §8" point there.

---

## 1. Problem

Terraform state is only half of what a run needs. The other half is the input
variables: database passwords, API tokens, CIDR ranges, instance sizes. Teams
keep these in one of three places, and all three are poor:

1. **A `.tfvars` file on a laptop.** Not shared, not backed up, and copied
   around in chat when someone else needs to run a plan.
2. **CI secrets.** Shared, but one flat namespace per repository, invisible to
   anyone without repo admin, with no record of who changed what.
3. **Committed to the repository.** Shared and versioned, and a leak.

statesman already holds an encryption key, scoped tokens, roles and an audit
log. Variables reuse all four.

### Goals

- Store variable values encrypted in the database, per project and environment.
- Deliver them to Terraform by pull: one authenticated `GET` returns a
  `.auto.tfvars.json` file.
- Work without state. A deployment can use statesman for variables only, for
  state only, or both. Neither feature requires the other.
- Optionally connect a GitHub repository, read its `variable` blocks, and show
  which declared variables are missing a value.
- Work fully without GitHub. Discovery is an aid, not a requirement.

### Non-goals

- Running Terraform. Delivery is pull-only, as for state (base §1).
- Pushing values into GitHub Actions secrets or any other system.
- Variable sets shared across projects, or project-wide values inherited by
  every environment. Each environment holds a complete set.
- Value history and rollback. Changes are audited; old values are not kept.
- Writing variables with an API token. Values change only through the
  dashboard.
- Environment variables (`TF_VAR_*`, provider credentials) as a separate
  category. A provider credential is stored as an ordinary variable.
- GitLab, Bitbucket, or any second provider.

---

## 2. Concepts

| Term | Meaning |
|---|---|
| **Project** | Unchanged. `org/project`, created by an admin. A project may have state, variables, or both. |
| **Environment** | New. A named set of variables inside a project: `dev`, `staging`, `production`. Slug rule identical to `projectSlug`. |
| **Variable** | New. One name, one encrypted value, inside one environment. |
| **Repository link** | New, optional. Ties one environment to a GitHub repository, branch and directory. |
| **Declared variable** | New, derived. A `variable` block found in the linked directory on the last sync. |

An environment is not a Terraform workspace and is not tied to the state
address. A project's state stays at `/api/tf/:org/:project` whatever
environments it has. Operators who keep one state per environment already
create one project per environment, and they create one environment per
project as well (typically named `default`).

---

## 3. Data model

New tables, alongside the base §5 model:

```ts
environment
  id            text pk
  projectId     text  → project.id  on delete cascade
  slug          text
  createdAt     timestamp
  unique (projectId, slug)

variable
  id            text pk                          // ULID
  environmentId text  → environment.id  on delete cascade
  name          text                             // Terraform identifier
  valueSealed   bytea                            // seal(key, JSON, aad)
  sensitive     boolean   not null default true
  description   text
  updatedBy     text  → user.id  on delete set null
  updatedAt     timestamp
  unique (environmentId, name)

github_installation
  installationId bigint pk                       // GitHub's id
  accountLogin   text                            // org or user that installed
  createdAt      timestamp

repository_link
  environmentId  text pk → environment.id  on delete cascade
  installationId bigint → github_installation.installationId on delete cascade
  repoId         bigint                          // stable across renames
  repoFullName   text                            // owner/name, for display
  ref            text                            // branch
  directory      text                            // root module path, '' = repo root
  lastSyncedAt   timestamp
  lastSyncedSha  text
  lastSyncError  text                            // null when last sync succeeded

declared_variable                                 // replaced wholesale per sync
  environmentId  text → repository_link.environmentId on delete cascade
  name           text
  typeExpr       text                            // e.g. "list(string)", null when untyped
  hasDefault     boolean
  sensitive      boolean
  description    text
  file           text
  line           integer
  pk (environmentId, name)
```

`bytea` needs a Drizzle `customType`. It is the first binary column in the
schema; ciphertext so far has lived in the blob store.

### Validation

- **Name:** `^[A-Za-z_][A-Za-z0-9_-]*$`, at most 128 characters. This is the
  Terraform identifier rule. A name Terraform cannot declare is refused rather
  than stored and silently ignored at plan time.
- **Value:** any JSON value: string, number, bool, null, list or object. This
  covers every Terraform type that `.tfvars.json` can carry. Serialised value at
  most 64 KiB.
- **Count:** at most 500 variables per environment.

All three live in `shared/schemas/variable.ts`, imported by the form and the
route, like `tokenScopeSchema`.

---

## 4. Encryption

Same key and algorithm as state (base §8). Variable values are sealed
individually.

`seal` and `open` in `server/utils/crypto.ts` gain an optional `aad` argument,
passed to `setAAD`. Variables always pass `variable:<variable.id>`. State
callers pass nothing, so the state wire format and every existing blob are
unchanged.

**Why AAD here and not for state:** a state blob's key is a ULID inside a
`state_version` row, so the row-to-ciphertext binding is by reference. A
variable's ciphertext sits inline in its own row. Without AAD, anyone who can
write to the database can copy the ciphertext of `prod/db_password` into
`dev/db_password`, and it decrypts cleanly. With AAD bound to the row id,
`open` throws. The binding is to the id, not the name, so a rename does not
need a re-seal.

Plaintext values never touch the blob store, the logs, or the audit log.

**Consequence:** losing `STATESMAN_ENCRYPTION_KEY` now loses variables as well
as state. Key rotation remains out of scope (base §8). The README's existing
warning is widened to say so.

---

## 5. Delivery to Terraform

```
GET /api/vars/:org/:project/:environment
Authorization: Basic base64("statesman:<token>")
→ 200 application/json
  { "db_password": "…", "instance_count": 3, "tags": { "team": "core" } }
```

The body is a valid `.tfvars.json` file. The documented use:

```bash
curl -fsS -u "statesman:$STATESMAN_TOKEN" \
  https://statesman.example.com/api/vars/acme/prod/production \
  -o statesman.auto.tfvars.json
terraform plan
```

Terraform loads `*.auto.tfvars.json` automatically, so no `-var-file` flag is
needed. The docs tell users to add `statesman.auto.tfvars.json` to
`.gitignore`.

- **JSON only.** No HCL output, so statesman never serialises HCL. No `TF_VAR_`
  export format: shell quoting of complex values is a source of bugs, and the
  file covers every case.
- **Every stored variable is returned**, including ones the linked repository
  no longer declares. Terraform warns about undeclared values in a variable file
  but does not fail, and dropping them silently would hide drift.
- **Headers:** `Cache-Control: no-store`.
- **Audit:** every successful read writes `variables.read` with the token id
  and environment. State reads are not audited, but this endpoint returns
  nothing except secrets, so who pulled them is the record worth having.

### Auth flow

The flow follows base §9, under a new door that shares the guard:

1. `authenticateTf`, unchanged: 401 on a missing, unknown, expired or
   rate-limited key.
2. Resolve `org/project`, then `environment`. Both unknown → 404.
3. `scopeAllows`, unchanged: 403 if the token is not scoped to the project.
4. Token must hold `vars: ['read']`: 403 otherwise.

Step 4 is the only new check. `TfPrincipal` gains `varActions`, read from
`result.key.permissions?.vars` with the same fail-closed parse as `actions`.

---

## 6. Tokens

Better Auth's `permissions` is resource→actions (base §4), so variables become
a second resource on the same key:

```ts
permissions: { state: ['read', 'write', 'lock'], vars: ['read'] }
```

- `tokenConfigSchema` gains `varActions: z.array(z.enum(['read'])).default([])`.
  `actions` (state) drops its `.min(1)`. A refinement requires at least one
  action across the two, so a token that grants nothing cannot be created.
- `toApiKeyBody` writes `permissions.vars`.
- **Existing tokens have no `vars` entry and so cannot read variables.** That is
  the fail-closed default. An existing token is not quietly widened.
- The token configurator gains a "Variables: read" checkbox beside the state
  actions. Project scope applies to both resources. A token scoped to
  `acme/prod` reads every environment of `acme/prod`. Per-environment scope is
  not offered, because environments are not an access boundary in this model:
  every account can already see every project.

---

## 7. Roles and visibility

Base §4's rule, that every account sees every project, still holds. One
exception is new: **sensitive values are write-only in the dashboard, for every
role.**

|                                            | admin | member |
| ------------------------------------------ | ----- | ------ |
| See environments, variable names, statuses | yes   | yes    |
| See non-sensitive values                   | yes   | yes    |
| See sensitive values                       | no    | no     |
| Create, edit, delete variables             | yes   | no     |
| Create, delete environments                | yes   | no     |
| Connect GitHub, link and sync repositories | yes   | no     |
| Create tokens with variable access         | yes   | no     |

No UI route returns a sensitive value, decrypted or sealed. A sensitive value
can be replaced, not revealed. The only way to read it is a token with
`vars: read`, and that read is audited. This is the one place where statesman
holds a secret that an admin cannot see in the dashboard. It is deliberate: an
admin can still mint a token and fetch the value, but that act leaves an audit
row, where a reveal button would leave nothing.

`sensitive` defaults to `true`. Unticking it is the deliberate act.

---

## 8. Dashboard

The project page gains a **Variables** tab next to the existing state view.
Projects with no state and no variables show both empty states, so a variables-
only deployment never looks broken.

**Environment switcher:** rendered only when the project has two or more
environments. With one environment, its name is a heading. With none, the empty
state offers **New environment** with the slug pre-filled as `default`.

**Variable table**, one row per name in `set ∪ declared`:

| Status | Meaning |
|---|---|
| **Missing** | Declared, no default, no value. Shown first, highlighted. |
| **Set** | Has a value. |
| **Optional** | Declared with a default, no value. |
| **Undeclared** | Has a value, but the linked directory does not declare it. |

Without a repository link, only **Set** exists, and the status column is not
rendered.

Value cells show non-sensitive values, and `••••••` with an "updated by X, Y
ago" line for sensitive ones. When a declared variable has a `description` and
the stored one is empty, the declared description is shown.

**Editing:** admins use a modal (the app's overlay, never `window.confirm`)
with name, a value editor, the sensitive toggle and a description. The value
editor accepts a plain string by default. A "JSON" switch accepts any JSON
value, which is how lists, maps, numbers and bools are entered. Editing a
sensitive variable starts with an empty value field, and leaving it empty keeps
the current value.

**Import:** an admin can paste or upload a `.tfvars.json` file. Imported
variables are marked sensitive. A preview lists the new names and the names
that will be overwritten before anything is written. HCL `.tfvars` import is
included only if the parser chosen in §9 can read it. See §12.

**Repository panel:** shows the link (repo, branch, directory), last sync time,
and a **Sync now** button. The commit SHA goes in a closed "Technical details"
disclosure with a copy button. A sync error is shown open, with GitHub's
message.

---

## 9. GitHub App integration

Optional. Enabled when all four variables below are set, and disabled, with
every GitHub control hidden, when none are. A partial set is a tier-1
configuration error at boot (base §10b), naming the missing variables.

| Variable | Meaning |
|---|---|
| `GITHUB_APP_ID` | Numeric app id |
| `GITHUB_APP_SLUG` | For the install URL `https://github.com/apps/<slug>/installations/new` |
| `GITHUB_APP_PRIVATE_KEY` | PEM. Literal `\n` sequences are accepted and unescaped, because most hosting panels take one line |
| `GITHUB_APP_WEBHOOK_SECRET` | HMAC secret for webhook delivery |

Every deployment registers its own app. statesman is self-hosted, so there is
no shared app. `docs/github-app.md` walks through it with the exact
permissions:

- **Repository permissions:** Contents: read, Metadata: read. Nothing else.
- **Events:** Push.
- **Setup URL:** `<BETTER_AUTH_URL>/api/github/setup`
- **Webhook URL:** `<BETTER_AUTH_URL>/api/github/webhook`

Read-only contents access is the whole footprint. statesman never writes to a
repository.

### Installing

1. An admin clicks **Connect GitHub**. statesman stores a random `state` value
   in the session and redirects to the install URL with it.
2. GitHub redirects back to `/api/github/setup?installation_id=…&state=…`.
3. statesman checks that `state` matches the session, then calls
   `GET /app/installations/:id` with the app JWT to confirm the installation
   exists and belongs to this app. Only then does it insert
   `github_installation`. A forged `installation_id` fails this check.

### Linking

An admin picks an installation, then a repository from the installation's list.
They type the branch (default: the repository's default branch) and the
directory, then save. Saving runs a sync immediately.

### Sync

1. Mint an installation token. Tokens are not stored. `@octokit/app` caches
   them in memory for their one-hour life.
2. List the directory at `ref` with the contents API. Fetch every `*.tf` file
   **directly in that directory**. Subdirectories are not read: they are child
   modules, and their variables are not inputs a `.tfvars` file can set.
3. Parse each file and collect the `variable` blocks: name, `type` expression
   as source text, presence of `default`, `sensitive`, `description`, and
   location.
4. In one transaction, replace that environment's `declared_variable` rows and
   update `lastSyncedAt`, `lastSyncedSha` and `lastSyncError = null`.

A failure at any step writes `lastSyncError` and leaves the previous
`declared_variable` rows in place. A failed sync does not mark every variable
**Undeclared**.

A file that fails to parse fails the whole sync. A partial declared set would
report variables as missing or undeclared on the strength of a parse error.

**Parser:** a tree-sitter HCL grammar via `web-tree-sitter` (WASM, runs on Node
and Vercel). It is chosen over `@cdktf/hcl2json` because CDKTF is no longer
maintained, and over a hand-written parser because heredocs and nested blocks
make "find the `variable` blocks" harder than it looks. The implementation
plan's first task is a spike that confirms the grammar parses the e2e fixture
and a set of real-world `variables.tf` files in a Vercel function. If the spike
fails, this section is revised before anything else is built.

### Triggers

- **Push webhook:** a push to a linked `repoId` and `ref` re-syncs every
  environment linked there. Signature: `X-Hub-Signature-256` verified with
  `timingSafeEqual` over the raw body, before any parsing. An unsigned or
  mis-signed delivery returns 401. A push to an unlinked repo or branch returns
  202 and does nothing.
- **Installation webhooks:** `installation.deleted` deletes the row, and its
  links cascade. `installation_repositories.removed` sets `lastSyncError` on
  the affected links. It does not delete them, because an admin may re-grant
  access.
- **Sync now** in the dashboard.

There is no polling. The webhook runs the sync inline: a few small file fetches
fit within a serverless invocation, and GitHub retries failed deliveries.

### Without GitHub

Every variable feature in §§3–8 works with no app configured. The status column
and the repository panel are simply absent.

---

## 10. Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/vars/:org/:project/:env` | token, `vars:read` | Delivery (§5) |
| `GET /api/ui/projects/:id/environments` | session | List |
| `POST /api/ui/projects/:id/environments` | admin | Create |
| `DELETE /api/ui/environments/:id` | admin | Delete, cascades variables and link |
| `GET /api/ui/environments/:id/variables` | session | Merged table rows. Sensitive values omitted |
| `PUT /api/ui/environments/:id/variables/:name` | admin | Create or replace |
| `DELETE /api/ui/environments/:id/variables/:name` | admin | Delete |
| `POST /api/ui/environments/:id/variables/import` | admin | `.tfvars.json` import; `?dryRun=1` for preview |
| `GET /api/github/install` | admin | Redirect to GitHub |
| `GET /api/github/setup` | admin | Install callback |
| `GET /api/ui/github/installations/:id/repositories` | admin | Repo picker |
| `PUT /api/ui/environments/:id/link` | admin | Link and sync |
| `DELETE /api/ui/environments/:id/link` | admin | Unlink |
| `POST /api/ui/environments/:id/sync` | admin | Sync now |
| `POST /api/github/webhook` | HMAC | Webhook |

The `/api/github/*` routes return 404 when the app is not configured.

**Audit actions:** `environment.create`, `environment.delete`,
`variable.set`, `variable.delete`, `variable.import`, `variables.read`,
`github.install`, `github.uninstall`, `repository.link`, `repository.unlink`,
`repository.sync_failed`. Metadata holds names, environment, the `sensitive`
flag and counts, never values.

---

## 11. Testing

Tests come first, following the existing pattern (base §13).

- **Unit**
  - `seal`/`open` with AAD: the round trip works; a mismatched AAD throws;
    calls without AAD still open existing state blobs. This last test is a
    golden ciphertext fixture produced by the current code.
  - Variable name and value schemas, including the size and count limits.
  - `toApiKeyBody` and the principal parse: a token without `vars` gets
    `varActions: []`.
  - Status merge: every combination of set, declared, has-default.
  - Webhook signature: valid, wrong secret, missing header, body altered by one
    byte.
  - Variable-block extraction against fixture `.tf` files: heredoc
    descriptions, complex `type` expressions, `sensitive`, a file with no
    variables, and a syntax error.
- **Integration (test database)**
  - Delivery: 401, 404 for unknown environment, 403 for out-of-scope project,
    403 for a state-only token, 200 body equal to the stored values.
  - A sensitive value never appears in any `/api/ui/*` response body. One test
    sweeps every UI route.
  - Row-swap: copying `valueSealed` between two rows makes delivery fail with
    500 rather than return the wrong secret.
  - Sync failure keeps the previous declared set.
- **End to end:** the existing fixture (`tests/e2e/fixture/main.tf`) declares
  `variable "value"`. The scenario stores `value` in statesman, curls it to
  `statesman.auto.tfvars.json`, runs `terraform apply`, and asserts on the
  output, with no `-var` flag.
- **GitHub:** no live calls in CI. API responses are recorded fixtures served
  by a mock `fetch`. A manual check against a real test app is listed in the
  plan's verification step.

---

## 12. Decisions for the reviewer

These were made by the author and should be confirmed or overturned before the
plan is written.

1. **Environments are explicit and per project**, not variable sets shared
   across projects (§2). Shared sets are the most likely follow-up.
2. **Sensitive values are write-only for admins too** (§7). The alternative is
   an audited admin-only reveal.
3. **No value history** (§1). History would mean keeping old secrets, encrypted,
   indefinitely.
4. **Delivery reads are audited** (§5), unlike state reads.
5. **HCL `.tfvars` import** depends on the parser spike (§9). If the
   tree-sitter grammar handles `.tfvars` cleanly, import accepts both formats.
   Otherwise import is JSON-only in v1.
6. **No feature flag for variables.** The tab is always present. Only GitHub is
   gated, by its configuration.

---

## 13. Documentation

These ship in the same change as the code:

- **README:** a "Variables" section with the curl recipe; the roles table gains
  the rows from §7; the key-loss warning covers variables.
- **`docs/github-app.md`:** app registration, permissions, URLs, environment
  variables, and how to verify a webhook delivery.
- **`docs/deploy-docker.md` and `docs/deploy-vercel.md`:** the four `GITHUB_APP_*`
  variables in their environment tables, marked optional.
- **Base spec:** a dated note at the top pointing here, like the 2026-09-08 note.
