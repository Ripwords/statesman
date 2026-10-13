# statesman checkout CLI — Design Spec

**Date:** 2026-10-13
**Status:** Implemented. Plan: docs/superpowers/plans/2026-10-13-checkout-cli.md.

> **Note (2026-10-13):** the CLI shipped inside the root package, built by
> `pnpm build:cli` to `cli/dist`, not as a separate workspace package, and it is
> not on npm yet. §9 describes the original intent.

A command-line tool that writes the gitignored Terraform files a checkout needs
(variable files, backend configuration, per-environment shell settings) from
what statesman stores, and reports which of them are missing or out of date.

This builds on the variables design
([2026-10-09-variables-design.md](2026-10-09-variables-design.md)); references
of the form "variables §5" point there.

---

## 1. Problem

A Terraform root applied to more than one account needs a set of gitignored
files per account. The motivating repository has, in one root:

| File | Holds |
|---|---|
| `<env>.tfvars` | that account's variables, one of them a secret |
| `backend.<env>.hcl` | that account's state bucket, region and KMS key |
| `.env.<env>` | `TF_DATA_DIR` and the `TF_CLI_ARGS_*` that select the other two |

None of them are in git. On a second machine there is no record of which files
should exist, which ones are stale, or where the right contents are. The usual
result is a half-configured machine: one account's files present, the other's
missing, and old copies of both lying around.

statesman already stores the variables, per project and environment
(variables §3), and delivers them to a token (variables §5). What it lacks is
the rest of the set, and a tool that writes the set and checks it.

### Goals

- One command writes every file an environment needs, on a laptop or in CI.
- One command reports, per file, whether it is current, missing, different or
  stray, with an exit code CI can gate on.
- The repository declares which files it needs. statesman supplies the values.
- Work with any backend type, not only statesman's own `http` backend.

### Non-goals

- Uploading local files or values to statesman. Values still change only in
  the dashboard (variables §1).
- Storing credentials. Provider credentials stay in the provider's own chain
  (`aws login`, profiles, OIDC in CI); the state token stays in
  `TF_HTTP_PASSWORD`.
- A login command or a token kept on disk. The token comes from
  `STATESMAN_TOKEN`.
- Running Terraform (`statesman exec`). The generated `.env` file covers it.
- Deleting files. Stray files are reported, never removed.
- Nested backend blocks (`assume_role { … }` in the `s3` backend). See §11.

---

## 2. Concepts

| Term | Meaning |
|---|---|
| **Manifest** | New. `statesman.json`, committed in a Terraform root. Names the project, its environments and the file name pattern for each kind of file. Holds no values. |
| **Backend settings** | New. A flat, non-secret map stored on an environment, rendered as a `backend.hcl` file. |
| **Checkout** | New. The set of files the manifest describes for one environment. |
| **Environment** | Unchanged (variables §2), plus backend settings. |

---

## 3. Data model

One nullable column on `environment`:

```ts
backend: jsonb('backend').$type<BackendSettings>()
```

`BackendSettings` is `Record<string, string | number | boolean>`. Null means
the environment has no backend settings and no backend file is written for it.

### Validation (`shared/schemas/backend.ts`)

- Keys match `^[a-z][a-z0-9_]*$`. At most 32 keys.
- Values are strings of at most 2048 characters, finite numbers, or booleans.
  No lists, no objects: a backend config file is a flat set of attributes, and
  nested blocks are out of scope (§11).
- **Credential-like keys are refused**, case-insensitively: `access_key`,
  `secret_key`, `token`, `password`, and any key ending in `_secret`, `_token`
  or `_password`. The error names the key and says where the value belongs:
  the provider's credential chain, or `TF_HTTP_PASSWORD` for statesman's own
  backend. Backend settings are stored in plaintext and shown in full, so
  anything secret placed here would bypass encryption.

Backend settings are not encrypted. They are bucket names, regions and key
ARNs, which the dashboard shows to anyone with a role on the project.

---

## 4. Server

### Editing backend settings

| Route | Auth | Purpose |
|---|---|---|
| `PUT /api/ui/environments/:id/backend` | owner or admin | Replace the map. `null` clears it |

The environment list (`GET /api/ui/projects/:id/environments`) includes
`backend` on each environment. Writes are refused on an archived project, as
for variables. Audit action `environment.backend.update`, metadata holds the
key names, never the values (values are not secret, but keeping audit metadata
value-free is the existing rule).

### Delivery

```
GET /api/checkout/:org/:project/:environment
Authorization: Basic base64("statesman:<token>")
→ 200 application/json
  { "variables": { "db_instance_class": "db.t4g.micro", … },
    "backend":   { "bucket": "…", "region": "ap-southeast-1" } | null }
```

- The check order is the variables door's, unchanged (variables §5): token,
  project, `vars:read` scope, creator access, then environment. No new token
  permission. A token that may read an environment's variables may read its
  backend settings, which are less sensitive.
- `variables` is exactly what `readDeliveryValues` returns, so it is the same
  set `/api/vars` delivers.
- `Cache-Control: no-store`. One audit row per call: `checkout.read` with the
  environment and the variable count.
- `/api/vars` is unchanged.

The response carries data, not rendered files. The CLI renders, so the server
does not need to know the file names the manifest chose, and the CLI can
compare a local file against the values without a second request.

### Shared rendering

`toTfvars` moves from `server/hcl/tfvars.ts` to `shared/hcl/tfvars.ts`. It is
pure and already handles quoting and escaping. Backend files render through the
same function: a flat map of literals is a valid `.tfvars` body and a valid
`-backend-config` file. The server imports it from its new path.

---

## 5. The manifest

`statesman.json`, in the Terraform root:

```json
{
  "server": "https://statesman.example.com",
  "project": "acme/sbf-ai",
  "environments": ["internal", "client"],
  "files": {
    "vars": "{env}.tfvars",
    "backend": "backend.{env}.hcl",
    "env": ".env.{env}"
  }
}
```

| Field | Rule |
|---|---|
| `server` | An `http` or `https` origin. `STATESMAN_URL` overrides it. |
| `project` | `org/project`, both parts matching the existing slug rule. |
| `environments` | One or more environment slugs, no duplicates. |
| `files.vars` | Required. Ends in `.tfvars` (HCL) or `.tfvars.json` (JSON). |
| `files.backend` | Optional. Omitted means no backend file is written. |
| `files.env` | Optional. Omitted means no `.env` file is written. |

- Every file pattern is a plain file name relative to the manifest's directory:
  no `/`, no `..`.
- With more than one environment, every pattern must contain `{env}`.
  Otherwise two environments would write the same file.
- With more than one environment, `files.vars` may not be `terraform.tfvars`,
  `terraform.tfvars.json`, or end in `.auto.tfvars` or `.auto.tfvars.json`.
  Terraform loads those on every run, so one environment's values would fill in
  whatever another environment's file leaves out. The error says so.
- `files.env` requires `files.vars`, which is always present, and uses
  `files.backend` if present.

The CLI validates the manifest with a Zod schema in `shared/schemas/manifest.ts`
and reports errors with the field path, e.g.
`statesman.json: files.vars: "client.auto.tfvars" is loaded by Terraform for every environment`.

---

## 6. Generated files

For environment `client` and the manifest above:

**`client.tfvars`**: `toTfvars(variables)`, or the JSON form for
`.tfvars.json`. Written with mode `0600`, because it holds secrets.

**`backend.client.hcl`**: `toTfvars(backend)`. Not written when the
environment's backend settings are null; `status` reports that as
`no backend settings in statesman`, not as missing.

**`.env.client`**: the CLI owns these keys and writes them:

```sh
TF_DATA_DIR=.terraform-client
TF_CLI_ARGS_init=-backend-config=backend.client.hcl
TF_CLI_ARGS_plan=-var-file=client.tfvars
TF_CLI_ARGS_apply=-var-file=client.tfvars
TF_CLI_ARGS_destroy=-var-file=client.tfvars
TF_CLI_ARGS_import=-var-file=client.tfvars
TF_CLI_ARGS_refresh=-var-file=client.tfvars
TF_CLI_ARGS_console=-var-file=client.tfvars
```

`TF_CLI_ARGS_init` is left out when there is no backend file. **Every other
line in an existing file is kept as it is**, in place, so a machine-specific
`AWS_PROFILE` survives every pull. Owned keys that already exist are updated
where they stand; missing ones are appended in the order above. A new file
starts with a one-line comment saying which lines the CLI owns.

All writes go to a temporary file in the same directory and are renamed into
place, so an interrupted pull never leaves a half-written file.

---

## 7. Commands

### `statesman pull`

```
statesman pull [--env <slug>]... [--dir <path>] [--force]
```

1. Read and validate `statesman.json` in `--dir` (default: the current
   directory). The CLI does not search upward: a repository with two roots
   would make that ambiguous.
2. `--env` limits the run to the named environments, each of which must be in
   the manifest. Default: all of them.
3. Refuse to continue if the vars file is not gitignored: `git check-ignore`
   on each target path. Skipped when the directory is not in a git repository.
4. Fetch `/api/checkout/...` for each environment.
5. For each file: write it if it is missing. If it exists and its contents
   already match, leave it alone. If it exists and differs, **refuse** and
   print what differs (§8), unless `--force` is given.

`pull` writes every file it can and then exits 1 if any file was refused,
listing them. It does not stop at the first refusal, so one changed file does
not block the others.

### `statesman status`

```
statesman status [--env <slug>]... [--dir <path>]
```

Reads the manifest, fetches the same data, writes nothing, and prints one line
per file:

```
client    client.tfvars        differs: openai_api_key, db_instance_class
client    backend.client.hcl   ok
client    .env.client          ok
internal  internal.tfvars      missing
internal  backend.internal.hcl missing
internal  .env.internal        missing
          .env.staging         stray: environment not in statesman.json
```

A **stray** is a file in the directory that matches one of the patterns for an
environment slug the manifest does not list. It is reported and never touched.

### Exit codes and output

| Code | Meaning |
|---|---|
| 0 | Every file is current (`status`), or every file was written or already current (`pull`) |
| 1 | Drift: something missing, different, stray or refused |
| 2 | Could not check: bad manifest, missing token, network, 401, 403, 404, 5xx |

- `--json` on both commands prints the same report as JSON, for CI.
- No prompts, ever. No colour when stdout is not a TTY.
- Errors name the cause and the fix:
  - no `STATESMAN_TOKEN` → `set STATESMAN_TOKEN to a token with Read Variables for acme/sbf-ai`
  - 401 → `statesman rejected STATESMAN_TOKEN (expired, revoked or mistyped)`
  - 403 → `this token cannot read variables of acme/sbf-ai`
  - 404 → `environment "client" does not exist in acme/sbf-ai; create it on the Variables tab`

---

## 8. Comparing a local file

A file is compared by meaning, not bytes, so a hand-written file formatted
differently from the CLI's output still counts as current.

- **Vars and backend files** are parsed with the existing HCL toolkit
  (`createHclToolkit`, given a loader that reads the wasm from the CLI's own
  package directory), or `JSON.parse` for `.tfvars.json`. The result is a map
  of name to value. Two maps match when they have the same names and deeply
  equal values.
- The diff lists **names only**: variables only in statesman, only in the
  local file, or in both with different values. It never prints a value, on a
  TTY or in `--json`.
- A local file that does not parse, or uses an expression rather than a
  literal (the toolkit refuses these, variables §12.5), is reported as
  `unreadable: <file>:<line>: <reason>`. That counts as drift.
- **`.env` files** are compared on the owned keys only. Other lines never make
  a file differ.

---

## 9. Distribution

The CLI is a second workspace package, `cli/`, in this repository.

- Entry `cli/src/main.ts`. It imports from `shared/` (schemas, `toTfvars`) and
  the toolkit, so the CLI and the server cannot disagree about formats.
- Built with esbuild into one ESM file, `cli/dist/statesman.mjs`, with the two
  wasm files copied beside it. No runtime dependencies except `web-tree-sitter`,
  which esbuild bundles.
- Node 24, the same as the server.
- Argument parsing with `node:util` `parseArgs`. No CLI framework.
- Published to npm so CI can run `npx -y <package>@<version> status`. The
  package name is a decision for the reviewer (§11).

---

## 10. Testing

Tests come first, following the existing pattern.

- **Unit**
  - Manifest schema: every refusal in §5 (auto-loaded names with two
    environments, missing `{env}`, path separators, `..`, duplicate
    environments) and a valid single-environment manifest that uses
    `terraform.tfvars`.
  - Backend settings schema: each credential-like key, case variants, nested
    values, the size limits.
  - `.env` merge: foreign lines kept in place, owned keys updated in place,
    missing owned keys appended in order, `TF_CLI_ARGS_init` dropped when there
    is no backend file, a file with Windows line endings.
  - Comparison: equal maps formatted differently match; each kind of
    difference is named; a value never appears in the report; an expression in
    a local file is `unreadable` with its line.
  - Stray detection: a pattern match for an unlisted slug is stray; a file that
    merely contains the pattern text is not.
  - `toTfvars` round trip after the move: output for a fixture map is
    byte-identical to the output before the move (golden file produced by the
    current code).
- **Integration (test database)**
  - `/api/checkout`: 401, 404 for an unknown project and environment, 403 for
    an out-of-scope token, 403 for a state-only token, 200 with `backend: null`
    and with settings, one `checkout.read` audit row.
  - `PUT /api/ui/environments/:id/backend`: owner and admin succeed; editor
    and viewer get 403; a credential-like key gets 400 naming the key; an
    archived project gets 409.
  - The UI-route sweep that proves no sensitive value appears in any
    `/api/ui/*` body still passes with the new route.
- **End to end:** a temp directory holding a manifest and the existing fixture
  `main.tf`. Two environments stored in statesman. `statesman pull` writes six
  files; `set -a; . ./.env.<env>; set +a; terraform init && terraform apply`
  succeeds for each; `statesman status` exits 0; editing one value in the
  dashboard makes `status` exit 1 naming that variable; `pull` refuses, and
  `pull --force` brings it back to 0. An `AWS_PROFILE` line added to a `.env`
  file survives the forced pull.

---

## 11. Decisions for the reviewer

1. **The repository holds the layout, statesman holds the values** (§5).
   Alternatives considered: layout stored per environment on the server, or a
   fixed file-naming convention built into the CLI.
2. **Backend settings are plaintext and shown in full** (§3), with
   credential-like keys refused rather than encrypted.
3. **Flat backend settings only.** The `s3` backend's `assume_role { … }` block
   cannot be expressed. A repository that needs it keeps that block in its
   committed `backend` block, which Terraform merges with the file.
4. **`pull` refuses to overwrite a changed file without `--force`** (§7). The
   alternative, statesman always wins, would silently throw away a local value
   that was never entered in the dashboard.
5. **`.terraform-{env}` for every environment.** A repository whose first
   environment used plain `.terraform` re-runs `terraform init` once after
   adopting the CLI. State is remote, so nothing is lost.
6. **npm package name**, and whether to publish at all before the first
   adopter has used it from a local build. Publishing is the one outward-facing
   step in this design.
7. **No new token permission.** `vars:read` covers backend settings.

---

## 12. Documentation

These ship in the same change as the code:

- **README:** a "Setting up a machine" section after "Variables": the manifest,
  `pull`, `status`, and the CI recipe. The roles table gains the backend
  settings row (owner and admin edit, everyone else reads).
- **`docs/cli.md`:** the reference: every flag, the manifest fields and
  refusals, exit codes, the error messages in §7, and how `.env` merging treats
  existing lines.
- **`docs/backend-config.md`:** a note that a project using another backend
  can store its backend settings in statesman and have the CLI write them.
- **Variables spec:** a dated note at the top pointing here.

---

## 13. Adopting it in the motivating repository

Not part of this change; listed so the design can be checked against a real
case.

1. Create environments `internal` and `client` in one statesman project. Import
   each account's existing `.tfvars` file through **Import**. Enter each
   account's bucket, region and KMS key as backend settings.
2. Commit `terraform/envs/prod/statesman.json` with the manifest in §5.
3. On each machine: `export STATESMAN_TOKEN=…`, `statesman status` to see the
   current state of the directory, then `statesman pull`, adding `--force`
   only after checking each refused file.
4. Run `terraform init` once for `internal`, which moves to
   `.terraform-internal`.
5. The repository's README replaces its "copy these three files" steps with
   step 3.

The bootstrap root's local state is a separate problem and is not addressed
here.
