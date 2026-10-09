# statesman

A self-hostable Terraform/OpenTofu HTTP state backend that encrypts state at
rest, keeps a browsable version history with a diff between any two versions,
and issues scoped API tokens instead of cloud credentials. It is not Terraform
Cloud: there is no remote execution, no policy engine, and no billing.

---

## Quickstart

Requires Node 24, pnpm, Docker, and Terraform or OpenTofu.

```bash
cp .env.example .env && pnpm install   # 1. dependencies and a local config
pnpm gen:key                           # 2. paste into STATESMAN_ENCRYPTION_KEY in .env
pnpm dev:setup && pnpm dev             # 3. postgres + minio, migrate, seed, run
```

Step 2 needs one more value: `BETTER_AUTH_SECRET`, any 32+ characters —
`openssl rand -base64 32`. The app refuses to start without either of them, and
says which one is missing.

(`dev:setup`, not `setup`: `pnpm setup` is a built-in pnpm command that
configures your shell, and it shadows a script of that name.)

There is no sign-up page. Create your account from the command line:

```bash
pnpm user:create you@example.com     # prints a generated password, once
```

The first account is always an admin. Later ones are members unless you add
`--role admin` — see [Roles](#roles-and-project-access).

Then sign in at http://localhost:3000 and:

1. **New Project** on the project list. It hands you the exact backend block for
   that project when it is created.
2. **Tokens → New Token**, scoped to it. The token is shown once and stored
   hashed — a token is always required, there is no anonymous access.

`pnpm dev:setup` also seeds one organization (`acme`) and one project (`prod`),
so the backend address below needs only a token.

> **Projects are never created implicitly.** An address statesman does not
> recognise is a 404, by design (spec §9) — so a typo in `address` fails loudly
> instead of quietly creating a second project and splitting your state across
> the two. Create them in the dashboard, through `POST /api/ui/projects`, or
> non-interactively with `STATESMAN_SEED_PROJECTS=prod,staging pnpm db:seed`,
> which is idempotent and safe to re-run.

---

## Point Terraform at it

```hcl
terraform {
  backend "http" {
    address        = "http://localhost:3000/api/tf/acme/prod"
    lock_address   = "http://localhost:3000/api/tf/acme/prod/lock"
    unlock_address = "http://localhost:3000/api/tf/acme/prod/lock"
    lock_method    = "POST"
    unlock_method  = "DELETE"
    username       = "statesman"
  }
}
```

The token is the Basic Auth **password**. Keep it out of the file:

```bash
export TF_HTTP_PASSWORD='sm_...'
terraform init
```

The username is ignored — Terraform requires something in the field, and
`statesman` is the convention this project documents.

### Why `lock_method = "POST"`

Terraform's `http` backend defaults to the `LOCK` and `UNLOCK` verbs, which are
non-standard HTTP methods inherited from WebDAV. Nitro dispatches them fine, but
whether a CDN, load balancer or serverless edge proxy forwards an unrecognised
verb is undocumented for most platforms — including Vercel's — and no
authoritative source states it either way.

So locking also lives on a dedicated `/lock` sub-path that takes `POST` to
acquire and `DELETE` to release. Two ordinary verbs, nothing exotic to forward.
The server accepts `LOCK`/`UNLOCK` on both paths as well, so a client configured
the default way still works; `POST`/`DELETE` is what these docs recommend
because it removes the platform question entirely.

---

## Variables

Optional. statesman can also keep a project's Terraform variables (tfvars),
encrypted at rest with the same key as state, and hand them to CI as a
`.tfvars.json` file. Nothing changes for a project that does not use it.

On the project page, open the **Variables** tab. Variables live in an
**environment** (`staging`, `prod`, or just `default`), so one project can carry
several sets. An owner or admin creates the first environment with **New environment**;
with two or more, a switcher appears.

- **Add variable** takes a name, a value and a description. Values are strings
  by default and are sent exactly as typed. Turn on **JSON** to give a number,
  boolean, list or object instead.
- **Edit** changes a variable. Its name cannot change.
- **Updated** shows when each variable was last saved and by whom.
- **Import** takes a JSON object (`{"region": "eu-west-1"}`) or a `.tfvars`
  file. It shows what it will create and overwrite before anything is written.

Variables are **sensitive** by default. A variable a linked repository declares
but that has no value yet also opens with **Sensitive** on, whatever its
`variable` block says. A sensitive value is write-only in the
dashboard: it is shown as `••••••`, never sent back to the browser, and an edit
that leaves the value empty keeps the current one. Only a token with **Read
Variables** can read it, through the download below. Anything you mark as not
sensitive is shown in the table.

Download an environment from CI with a token that has **Read Variables**:

```bash
curl -fsS -u "statesman:$STATESMAN_TOKEN" \
  http://localhost:3000/api/vars/acme/prod/default \
  -o statesman.auto.tfvars.json
```

Terraform loads `*.auto.tfvars.json` on its own. Add `statesman.auto.tfvars.json`
to `.gitignore`, because the file holds the secrets.

A value for which the configuration has no matching `variable` block makes
Terraform print a warning. It does not fail the run.

### Finding out which variables a repository declares

Also optional. An owner or admin can link an environment to a GitHub repository from the
Variables tab, so statesman reads the `variable` blocks in its `.tf` files and
marks each stored variable as declared or not. A declared `description` shows
in the table until you store one of your own; the edit form leaves it out, so
saving does not copy it. It only reads, and it needs a
GitHub App that you register for your own deployment. Without one the tab shows
no repository panel at all. [docs/github-app.md](docs/github-app.md) walks
through registering it, connecting it and fixing a failed sync.

## Roles and project access

There is no public sign-up — `POST /api/auth/sign-up/email` is refused — and
accounts exist only because an operator ran `pnpm user:create`, which needs
database access and `BETTER_AUTH_SECRET`.

There are two levels. A **deployment admin** manages the whole deployment and
sees every project. Every other account is a **member** of the deployment and
sees only the projects it holds a **project role** on: `viewer`, `editor` or
`owner`. An account with no role on a project cannot tell that it exists; the
project is absent from its list and its address answers 404.

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

An account sees only projects it has a role on. Admins see every project, with
or without a role of their own.

The first account on a deployment is always an admin — nothing else could
promote it — and every account after that is a member unless you pass
`--role admin`. The last admin cannot be demoted, because the deployment would
be left with nobody able to manage accounts, projects or retention and no
endpoint that could undo it.

> Sensitive variables are write-only in the dashboard for every role, admins
> included. Only a token with **Read Variables** can read them.

### Adding people

1. An admin creates the account: `pnpm user:create them@example.com`.
2. An owner of the project, or an admin, opens the project's **Members** tab,
   chooses **Add Member**, enters the account's email and a role.

Owners must type the exact email of an existing account; there is no directory
to browse, and an unknown email is refused. Anyone with a role on the project
can see its member list. On the same tab an owner changes a member's role from
the role select on their row, or removes them. A project may end up with no
owner; an admin can always recover it, and the dashboard asks for confirmation
before the last owner is removed or demoted. On the **Users** page each
member's row has an **N projects** button that opens the list of their projects
and roles; an admin's row reads **All projects**.

### Upgrading

Existing member accounts become viewers on every existing project, so nobody
loses access. Narrow it from each project's **Members** tab.

### Tokens

Scoped API tokens are for machines: a token names the exact projects and
operations it may use, so a CI runner can be given far less than a person.

- **Creating** a token needs a deployment admin, or an account that is an owner
  of every project the token names. A token with `all` scope (**All My
  Projects**) is admin-only.
- **Listing and revoking:** every signed-in account, admins included, sees and
  revokes only the tokens it created, on the Tokens page. To cut off someone
  else's tokens, remove them from the project, or have an admin delete or demote
  the account: their tokens stop working at once, because a token never outranks
  its creator. The Tokens entry in the navigation shows for admins, project
  owners and anyone who already holds a token.
- **A token never outranks its creator.** It stops working on a project when
  its creator no longer holds the role the request needs: reading state needs
  any role; writing, locking or deleting state needs editor; reading variables
  needs owner. The request is refused with a 403 saying the creating account no
  longer has access. The token is not revoked, and it works again if the
  creator's role is restored. An `all`-scope token works only while its creator
  is an admin.

Reading variables is its own permission, **Read Variables**, and it is off by
default. Tokens created before it existed do not have it, so they cannot
download variables; issue a new token that does.

### Passwords

`pnpm user:create` prints a generated password once. Anyone can change their own
under **Account → Change Password**, which asks for the current one and signs
out every other session. An admin can reset someone else's from **Users**, which
generates one, shows it once, and ends that account's sessions immediately — but
never their own, because a reset does not ask for the current password and that
is not a door to leave open on the account you are signed in as.

There is no email recovery: statesman sends no mail. If every admin is locked
out, `pnpm user:create` from a machine with database access is the way back.

---

## Back up `STATESMAN_ENCRYPTION_KEY` separately from the database

> **Lose this key and every stored version of state **and variables** is
> permanently unreadable.** There is no recovery path, no escrow,
> and no support channel that can help. Terraform state cannot be regenerated — it is the only record
> of which real resource each address maps to.

State **and variables** are encrypted with AES-256-GCM before they reach storage. The key lives
only in the environment. It is not in the database, not in the blob store, and
not derivable from either.

Two rules follow:

1. **Back the key up** — a password manager, a secrets manager, a sealed
   envelope. Somewhere that survives losing the machine.
2. **Back it up somewhere the database backup is not.** A backup containing both
   the ciphertext and its key is a single artefact that decrypts itself, which
   is exactly the property encryption at rest exists to prevent. Keeping them
   apart is the entire point.

Key rotation is not implemented in v1. Choose a key you can keep.

---

## statesman or the `s3` backend?

|                                            | statesman                                                        | `s3` backend                                            |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------- |
| What each developer and CI runner holds    | one scoped API token                                             | AWS IAM credentials                                     |
| Scope of a leaked credential               | the projects on the token                                        | whatever the IAM policy allows                          |
| State readable by whoever holds the bucket | no — encrypted before it is stored                               | yes — SSE decrypts transparently for any `s3:GetObject` |
| "Who changed this, and what changed?"      | timeline with actor and timestamp, diff between any two versions | object versions; no actor, no diff                      |
| Locking                                    | a Postgres row, survives process death                           | S3 conditional writes (DynamoDB before Terraform 1.10)  |
| Infrastructure you operate                 | an app, Postgres, and a blob store                               | none                                                    |
| Availability of your state                 | yours to keep up                                                 | Amazon's                                                |
| Maturity                                   | new                                                              | the default since 2014, in use everywhere               |

### When `s3` is the better choice — and for most teams on AWS, it is

Use the `s3` backend if:

- **You are already on AWS and your team already has IAM.** The credential
  friction statesman removes is friction you have already paid for. Adding a
  service to avoid it is a bad trade.
- **You cannot afford another thing to operate.** statesman is a stateful
  service: a web app, a Postgres you must back up, and a blob store. S3 is
  someone else's problem, at four nines, for pennies.
- **Nobody who can read the bucket is outside your trust boundary.** The
  encryption gap statesman closes only matters when "has `s3:GetObject`" and
  "may read production database passwords" are different sets of people.
- **You need proven behaviour under load and failure.** S3 has had a decade of
  every edge case found by everyone. This has not.

Choose statesman when the specific gaps bite: contractors or CI systems that
need state but should not hold cloud credentials, state files whose plaintext
secrets outrank the bucket's own access controls, or an audit question
("who applied this, and what did it change?") that object versioning cannot
answer.

---

## Deploying

- [docs/deploy-docker.md](docs/deploy-docker.md) — Docker Compose, self-hosted
- [docs/deploy-vercel.md](docs/deploy-vercel.md) — Vercel, Neon, S3
- [docs/backend-config.md](docs/backend-config.md) — every backend and token
  setting, and how to wire it into CI

## Operational notes

- **`terraform force-unlock` needs the lock ID**, and the CLI prints only that.
  When a lock is held, Terraform's error reads
  `HTTP remote state already locked: ID=<lock id>` — the `Lock Info:` block
  underneath describes _your_ failed attempt, not the holder's. Verified against
  Terraform 1.14.9; it is how `httpClient.Lock` builds the error. The holder's
  name is in the response and is shown in the dashboard's lock banner, so that
  is where to look for _who_, and force-unlock is also a button there.
- **Creating an account** is `pnpm user:create <email> [name] [--role admin|member]`.
  It needs only `DATABASE_URL` and `BETTER_AUTH_SECRET` — deliberately not the
  encryption key — so it runs from an operator machine or the migration
  container. The role defaults to `member`, except on a deployment with no admin
  yet, where it makes one and says so.
- **`pnpm vendor:wasm`** copies the HCL parser's two `.wasm` files from
  `node_modules` into `server/assets/wasm/`, where they are committed so every
  deployment preset bundles them. Run it after bumping `web-tree-sitter` or
  `@tree-sitter-grammars/tree-sitter-hcl`, and commit the result. The unit test
  `tests/unit/wasm-vendored.test.ts` fails until you do.
- **Retention** runs as a scheduled task at 03:17 daily on a long-running
  server. Nitro has no scheduler on serverless, so a Vercel deployment needs an
  external trigger: set `CRON_SECRET` and the bundled `vercel.json` cron calls
  `GET /api/admin/retention` with it at the same 03:17. Without that variable
  the GET route is a 404, so an unset secret never becomes an open endpoint.
  `POST /api/admin/retention` is the manual, admin-only trigger on any
  deployment.
- **Creating a project** is `POST /api/ui/projects` — admin-only, body
  `{ "org": "acme", "project": "myapp-prod" }`, with `org` optional on a
  single-organization deployment. A duplicate is a 409, a slug the router could
  not resolve is a 400. `pnpm db:seed` is the same thing without a browser.
- **Retention thresholds** keep the last 100 versions and everything from the
  last 30 days, whichever is greater. The current version is never pruned, and
  an orphaned blob is left alone for an hour before it is swept, because a blob
  younger than that may be a write still in progress.
- **`GET /api/health`** is unauthenticated and runs four probes — encryption
  key round-trip, database, migrations applied, blob store writable. It reports
  names and pass/fail only, never configuration.

## Development

```bash
pnpm test          # unit, protocol and integration suites
pnpm test:e2e      # real terraform, against both storage drivers
pnpm typecheck
pnpm lint
```

The e2e suite drives the actual Terraform CLI against a real server process,
once per storage driver. It needs `terraform` on PATH and the local stack
running (`pnpm dev:setup`).

## License

MIT.
