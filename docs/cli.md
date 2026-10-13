# statesman CLI reference

The `statesman` command writes the gitignored files a Terraform checkout needs,
and reports which of them are missing or out of date.

---

## What it does

A Terraform root that is applied to more than one account needs a set of files
per account that are not in git: a variable file, a backend config file and a
shell file that points Terraform at both. statesman already stores the
variables, and can store the backend settings, per project and environment. The
CLI reads them with a token, renders the files, and writes them next to a
committed `statesman.json` that names the files. `status` writes nothing and
tells you what is current. `pull` writes what is missing. The CLI only reads
from statesman: values change in the dashboard.

---

## Install

The CLI is not on npm yet. Build it from a statesman checkout:

```bash
pnpm build:cli
alias statesman="node /path/to/statesman/cli/dist/statesman.mjs"
```

`cli/dist/` holds `statesman.mjs` and two `.wasm` files. The `.mjs` file needs
the `.wasm` files beside it, so copy the whole `cli/dist/` directory when you
move it, for example into a CI job. Node 24 is required.

---

## `statesman.json`

Commit this file in the Terraform root. It holds no values.

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
| `server` | An `http` or `https` URL. `STATESMAN_URL` overrides it. A path prefix (`https://host/statesman`) is kept |
| `project` | `org/project`, each part a project slug |
| `environments` | One or more environment slugs, no repeats |
| `files.vars` | Required. Ends in `.tfvars` (HCL) or `.tfvars.json` (JSON) |
| `files.backend` | Optional. Left out means no backend file is written |
| `files.env` | Optional. Left out means no `.env` file is written |

`{env}` in a pattern is replaced by the environment slug. No other fields are
allowed, at the top level or under `files`.

### Refusals

Each refusal is printed as `statesman: statesman.json: <field>: <reason>` and
exits 2. The text below is the `<reason>`.

| Cause | Message |
|---|---|
| File is not JSON | `statesman.json: not valid JSON` (no field) |
| `server` is not an http(s) URL | Zod's URL message for `server` |
| `project` is not `org/project` | `must be org/project` |
| `environments` is empty | Zod's minimum-length message for `environments` |
| An environment appears twice | `must not repeat an environment` |
| A file pattern has a `/`, a space or any character other than letters, digits, `.`, `_`, `-` and `{env}` | `must be a file name in this directory: letters, digits, . _ - and {env}` |
| A file pattern is `.` or `..` | `must be a file name in this directory` |
| `files.vars` does not end in `.tfvars` or `.tfvars.json` | `must end in .tfvars or .tfvars.json` |
| Two or more environments, and `files.vars` is `terraform.tfvars`, `terraform.tfvars.json`, or ends in `.auto.tfvars` or `.auto.tfvars.json` | `files.vars: "<name>" is loaded by Terraform for every environment, so one environment's values would leak into another's runs` |
| Two or more environments, and a pattern has no `{env}` | `files.<kind>: "<pattern>" has no {env}, so every environment would write the same file` |
| An unknown field | Zod's unrecognized-key message |

A manifest with one environment may use `terraform.tfvars` and patterns with no
`{env}`. Only the first problem found is reported.

---

## Commands

```
statesman status [--env <slug>]... [--dir <path>] [--json]
statesman pull   [--env <slug>]... [--dir <path>] [--force] [--json]
statesman help
```

| Flag | Meaning |
|---|---|
| `--env <slug>` | Limit the run to this environment. Repeat it for several. Each must be in `statesman.json`. Default: all |
| `--dir <path>` | The directory that holds `statesman.json`. Default: the current directory. The CLI does not search upward |
| `--force` | `pull` only. Overwrite files that differ (see below) |
| `--json` | Print the report as JSON instead of text |
| `--help` | Print the usage and exit 0 |

| Variable | Meaning |
|---|---|
| `STATESMAN_TOKEN` | Required. A token with **Read Variables** for the manifest's project |
| `STATESMAN_URL` | Overrides `server`. Must be an http(s) URL without credentials. A path prefix is kept |

The CLI never prompts. It never prints a variable value, in text or in JSON:
reports name variables, not what they hold.

### `status`

Fetches each environment, compares it with the files on disk, and prints one
line per file. It writes nothing.

```
client    client.tfvars        differs: openai_api_key, db_instance_class
client    backend.client.hcl   ok
client    .env.client          ok
internal  internal.tfvars      missing
internal  backend.internal.hcl missing
internal  .env.internal        missing
          .env.staging         stray: environment "staging" not in statesman.json
```

| State | Meaning | Counts as drift |
|---|---|---|
| `ok` | The file matches | no |
| `missing` | The file does not exist | yes |
| `differs: <names>` | The file exists and differs | yes |
| `unreadable: <file>:<line>: <reason>` | The file does not parse, or holds an expression instead of a literal | yes |
| `stray: environment "<slug>" not in statesman.json` | The file name matches a pattern for an environment the manifest does not list | yes |
| `no backend settings in statesman` | `files.backend` is set but this environment has none. No file is expected | no |

In a `differs` list a bare name has different values in statesman and on disk,
`+name` is only in statesman, and `-name` is only in the local file. For a
`.env` file the names are the owned keys (below) that differ or should not be
there.

How files are compared:

- Vars and backend files are compared by meaning, not bytes. A hand-written
  file with other formatting, order or comments counts as current if it holds
  the same names and values.
- `.env` files are compared on the keys the CLI owns. Other lines never make a
  file differ.
- A stray is never touched. Files that git tracks are never reported as stray.

### `pull`

Does the same comparison, then writes:

- A missing file is written.
- A file that matches is left alone.
- A file that differs is refused, and its differing names are printed, unless
  you pass `--force`. `--force` applies to every file, `.env` files included.

`pull` writes every file it can, then exits 1 if any file was refused. One
changed file does not block the others. Output uses the same lines as `status`,
with `written`, `updated: <names>` or `refused, differs: <names> (use --force
after checking)`.

Before it contacts the server, `pull` checks that each vars file is gitignored
(`git check-ignore`). If one is not, it stops with exit 2 and writes nothing.
The check is skipped when the directory is not in a git repository. It fetches
every environment before it writes any file, so a failure on one environment
leaves the others untouched.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | `status`: every file is current. `pull`: every file was written or already current |
| 1 | Drift: something is missing, different, stray or refused |
| 2 | The CLI could not check: bad manifest, bad flags, missing token, network failure, a 401, 403, 404 or 5xx, a git failure, or a file it could not read or write |

With `--json` the output is:

```json
{
  "exitCode": 1,
  "files": [
    { "env": "client", "file": "client.tfvars", "kind": "vars",
      "state": "differs", "detail": ["db_instance_class"], "action": null }
  ]
}
```

`state` is one of `ok`, `missing`, `differs`, `unreadable`, `stray`,
`no-backend`. `kind` is `vars`, `backend`, `env` or `null` for a stray. `action`
is `written`, `refused` or `null` (always `null` for `status`). Errors with
exit 2 are printed on stderr as text, not JSON.

---

## What `pull` writes

For environment `client` and the manifest above:

| File | Content | Mode |
|---|---|---|
| `client.tfvars` | The environment's variables, sorted by name. JSON for a `.tfvars.json` pattern | `0600` when new |
| `backend.client.hcl` | The environment's backend settings, sorted by name. Not written when it has none | `0644` when new |
| `.env.client` | The owned keys below | `0644` when new |

A file that already exists keeps its permission bits when it is rewritten. Each
write goes to a temporary file in the same directory and is renamed into place,
so an interrupted pull never leaves half a file.

**The `.env` file.** The CLI owns these keys:

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

`TF_CLI_ARGS_init` is left out when the environment has no backend file (and
removed if an earlier pull wrote it). Every other line in an existing file is
kept as it is, in place, so a machine-specific `AWS_PROFILE` survives every
pull, `--force` included. Owned keys that exist are updated where they stand,
and missing ones are appended in the order above. Line endings (LF or CRLF) are
kept. A new file starts with a comment that says which lines the CLI owns.

Without `--force`, a `.env` file whose owned keys differ is refused like any
other file. With `--force` the owned keys are corrected and nothing else changes.

After a pull:

```bash
set -a; . ./.env.client; set +a
terraform init && terraform plan
```

---

## In CI

Store a token with **Read Variables** as the secret `STATESMAN_TOKEN`. Copy the
whole `cli/dist/` directory into the job, or build it there with `pnpm
build:cli`.

```yaml
- name: Check out the Terraform files
  env:
    STATESMAN_TOKEN: ${{ secrets.STATESMAN_TOKEN }}
  run: node tools/statesman/statesman.mjs pull --env client

- name: Plan
  run: |
    set -a; . ./.env.client; set +a
    terraform init
    terraform plan
```

To fail a job when a checkout has drifted, without writing anything:

```yaml
- name: Gate on drift
  env:
    STATESMAN_TOKEN: ${{ secrets.STATESMAN_TOKEN }}
  run: node tools/statesman/statesman.mjs status --json
```

The step fails on exit 1 (drift) and on exit 2 (could not check). On a fresh CI
runner every file is missing, so use `pull` there and `status` where files
already exist.

---

## Errors

Every error is printed on stderr as `statesman: <message>`. All of these exit 2
unless noted.

| Message | What to do |
|---|---|
| `no statesman.json in <dir>` | Run from the Terraform root, or pass `--dir` |
| `statesman.json: ...` | See [Refusals](#refusals) |
| `environment "<slug>" is not in statesman.json (<list>)` | Use an environment from the list, or add it to the manifest |
| `set STATESMAN_TOKEN to a token with Read Variables for <org/project>` | Export the token |
| `server in statesman.json must be an http(s) URL` / `... without credentials` | Fix `server`. Put no `user:password@` in it |
| `STATESMAN_URL must be an http(s) URL` / `... without credentials` | Fix or unset `STATESMAN_URL` |
| `could not reach statesman at <origin>` | Check the address, the network and that the server is up. Requests time out after 30 seconds |
| `statesman rejected STATESMAN_TOKEN (expired, revoked or mistyped)` | Mint a new token on the Tokens page |
| `this token cannot read variables of <org/project>` | The token lacks **Read Variables**, is scoped to other projects, or its creator is no longer a project owner |
| `environment "<slug>" does not exist in <org/project>; create it on the Variables tab` | Create the environment, or fix the manifest |
| `statesman answered <status> for <org/project>/<slug>` | A 5xx or other unexpected status. Retry, then check the server's logs |
| `statesman sent an unexpected response for <org/project>/<slug>` | The server and CLI versions disagree. Rebuild the CLI from the same revision |
| `<file> is not gitignored and would be committed; add it to .gitignore first` | Add the vars file to `.gitignore`, then pull again |
| `git failed (exit <code>); fix the repository and retry` | Git is installed but the repository is broken. `pull` stops before it writes secrets |
| `git check-ignore failed (exit <code>)` / `git ls-files failed (exit <code>)` | As above |
| `<file>: cannot read (<code>)` | A file exists but cannot be read, for example a permission error (`EACCES`) |
| `<file>: cannot write (<code>)` | The file or directory is not writable |
| `unknown command <name>` followed by the usage | Use `status`, `pull` or `help` |
| An unknown flag or a missing flag value, followed by the usage | Check the flags above |
| `statesman: unexpected <ErrorName>` | A bug in the CLI. The message holds only the error's type, so no value leaks. Report it |

Exit 1 is not an error message: it is drift, listed in the report.
