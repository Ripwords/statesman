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

Then open http://localhost:3000, sign up, and:

1. **New Project** on the project list. It hands you the exact backend block for
   that project when it is created.
2. **Tokens → New Token**, scoped to it. The token is shown once and stored
   hashed.

`pnpm dev:setup` also seeds one organization (`acme`) and one project (`prod`),
so the backend address below works immediately without either step.

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
- **Creating a project** is `POST /api/ui/projects` — session-guarded, body
  `{ "org": "acme", "project": "myapp-prod" }`, with `org` optional on a
  single-organization deployment. A duplicate is a 409, a slug the router could
  not resolve is a 400. `pnpm db:seed` is the same thing without a browser.
- **Retention** keeps the last 100 versions and everything from the last 30
  days, whichever is greater, and never prunes the current version. `POST
/api/admin/retention` runs a pass; it is session-guarded.
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
