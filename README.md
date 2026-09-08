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
`--role admin` — see [Roles](#roles-and-what-every-account-can-still-read).

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

## Roles, and what every account can still read

There is no public sign-up — `POST /api/auth/sign-up/email` is refused — and
accounts exist only because an operator ran `pnpm user:create`, which needs
database access and `BETTER_AUTH_SECRET`.

There are two roles:

|                                  | admin | member |
| -------------------------------- | ----- | ------ |
| Read projects, versions, diffs   | yes   | yes    |
| Create projects                  | yes   | no     |
| Force unlock, roll back          | yes   | no     |
| Create and revoke tokens         | yes   | no     |
| Manage accounts and roles        | yes   | no     |
| Reset another account's password | yes   | no     |
| Run retention on demand          | yes   | no     |

The first account on a deployment is always an admin — nothing else could
promote it — and every account after that is a member unless you pass
`--role admin`. The last admin cannot be demoted, because the deployment would
be left with nobody able to manage accounts, tokens or locks and no endpoint
that could undo it.

**The split is about who may change things, not about who may see them.** Both
roles read every project's decrypted state, and there are still no per-project
permissions and no ownership:

> Creating an account of either role grants read access to the **plaintext** of
> every state file in the deployment, including the provider credentials and
> database passwords inside them. If some people should see only some projects,
> run a second deployment; do not give them an account here.

Scoped API tokens are the finer-grained control, and they are for machines: a
token names the exact projects and operations it may use, so a CI runner can be
given far less than a person.

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

> **Lose this key and every version of every state file is permanently
> unreadable.** There is no recovery path, no escrow, and no support channel
> that can help. Terraform state cannot be regenerated — it is the only record
> of which real resource each address maps to.

State is encrypted with AES-256-GCM before it reaches storage. The key lives
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
