# Deploying to Vercel

Vercel runs the app as serverless functions, which changes two things: the
filesystem is ephemeral, and database connections cannot be pooled across
invocations. Both are configuration, and both are enforced at boot.

- `STORAGE_DRIVER` **must** be `s3`. The server refuses to start with
  `local` when it detects a serverless platform — the filesystem would appear to
  work in testing and silently lose every state file on the next cold start.
- `DB_DRIVER` **must** be `neon`, which uses `@neondatabase/serverless` over
  HTTP instead of a TCP pool.

> **This is not the deployment to pick if you can run a container.**
> `docs/deploy-docker.md` is simpler, needs no external bucket, and the
> connectivity probes actually gate startup there. On Vercel they are skipped —
> see *Health checks* below.

---

## 1. Provision

- **Database** — a Neon Postgres. Copy the *pooled* connection string.
- **Bucket** — S3, R2, B2, or anything S3-compatible. Private, no public access.
  The credentials need `GetObject`, `PutObject`, `DeleteObject` and
  `ListBucket` on it; nothing else, and not `CreateBucket`.

## 2. Environment variables

Set these in **Project → Settings → Environment Variables**, for every
environment the project deploys.

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | **yes** | Neon pooled connection string |
| `DB_DRIVER` | **yes** | `neon` |
| `STORAGE_DRIVER` | **yes** | `s3` |
| `S3_BUCKET` | **yes** | bucket name |
| `STATESMAN_ENCRYPTION_KEY` | **yes** | 32 bytes base64, from `pnpm gen:key`. **[Back this up separately from the database.](../README.md#back-up-statesman_encryption_key-separately-from-the-database)** Vercel's dashboard is not a backup — you cannot read the value back after saving it |
| `BETTER_AUTH_SECRET` | **yes** | 32+ characters, `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | **yes** | the production domain, e.g. `https://statesman.example.com` |
| `S3_ENDPOINT` | for non-AWS | e.g. `https://<account>.r2.cloudflarestorage.com` |
| `S3_REGION` | no | defaults to `us-east-1`; R2 wants `auto` |
| `S3_ACCESS_KEY_ID` | yes on Vercel | there is no instance role to fall back to |
| `S3_SECRET_ACCESS_KEY` | yes on Vercel | |
| `S3_FORCE_PATH_STYLE` | no | `false` unless your endpoint needs it |
| `RETENTION_KEEP_VERSIONS` | no | defaults to `100` |
| `RETENTION_KEEP_DAYS` | no | defaults to `30` |

`BETTER_AUTH_URL` must match the origin browsers actually use. A preview
deployment on a `*.vercel.app` URL will not complete a sign-in against a
production `BETTER_AUTH_URL`.

## 3. Migrations

`vercel.json` puts them in the build command, because Vercel has no separate
pre-deploy hook:

```json
{
  "framework": "nuxtjs",
  "buildCommand": "pnpm drizzle-kit migrate && pnpm build"
}
```

Two consequences worth knowing before you rely on it:

- **Every deployment migrates, including previews.** A preview build pointed at
  the production `DATABASE_URL` will migrate production. Give preview
  environments their own database, or drop the migrate step from
  `buildCommand` and run `pnpm db:migrate` from an operator machine instead.
- **A build that migrates and then fails still leaves the database migrated.**
  The schema moves forward before the code does. This project's migrations are
  additive, so the previous version keeps working, but that is a property to
  preserve rather than assume.

## 4. Seed the organization

The organization is a deployment-level thing (spec §5) and nothing in the app
creates one, so it has to exist before anybody can sign in. The seed script
needs only `DATABASE_URL` — not the encryption key — so run it from a checkout:

```bash
DATABASE_URL='postgres://...' pnpm db:seed
```

```
Seeded organization: acme
Seeded project: acme/prod
```

**Projects, after this, are made in the dashboard** — *New Project* on the
project list, which hands you the backend block for it — or through
`POST /api/ui/projects`. Nothing is created implicitly: an address statesman
does not recognise is a 404, so a typo in `address` fails loudly rather than
silently splitting a team's state across two projects.

Seeding remains the non-interactive route, for provisioning from CI: add
`STATESMAN_SEED_PROJECTS=prod,staging,sandbox`. It is idempotent.

## 5. Health checks

The startup connectivity probes are **skipped on serverless**. Functions
cold-start constantly and Neon scales to zero, so a database round trip on every
cold start would add latency to every request and turn a brief upstream blip into
a hard outage.

`GET /api/health` still runs all four on demand, so check it once after the first
deploy — this is the step that catches a bucket the function cannot write to:

```bash
$ curl -s https://statesman.example.com/api/health
{"status":"ok","checks":[{"name":"encryption","ok":true,"ms":0},
{"name":"database","ok":true,"ms":12},{"name":"migrations","ok":true,"ms":8},
{"name":"storage","ok":true,"ms":41}]}
```

A `503` names the failing check without revealing any configuration; the
endpoint is unauthenticated, so it reports pass/fail only.

## 6. Verify with real Terraform

Create your account first — there is no sign-up page, by design. The script
needs only `DATABASE_URL` and `BETTER_AUTH_SECRET`, so run it from a checkout:

```bash
DATABASE_URL='postgres://...' BETTER_AUTH_SECRET='...' \
  pnpm user:create you@example.com "Your Name"
```

> **Every account you create can read every project**, including the decrypted
> plaintext of every state file. There are no roles and no per-project
> permissions — see the README.

Then sign in at your domain, mint a token on the **Tokens** page, and:

```bash
mkdir statesman-check && cd statesman-check
cat > main.tf <<'EOF'
terraform {
  backend "http" {}
}
resource "terraform_data" "canary" {
  input = "hello"
}
EOF

export TF_HTTP_ADDRESS="https://statesman.example.com/api/tf/acme/prod"
export TF_HTTP_LOCK_ADDRESS="$TF_HTTP_ADDRESS/lock"
export TF_HTTP_UNLOCK_ADDRESS="$TF_HTTP_ADDRESS/lock"
export TF_HTTP_LOCK_METHOD=POST
export TF_HTTP_UNLOCK_METHOD=DELETE
export TF_HTTP_USERNAME=statesman
export TF_HTTP_PASSWORD='sm_...'

terraform init
```

```
Initializing the backend...

Successfully configured the backend "http"! Terraform will automatically
use this backend unless the backend configuration changes.
Initializing provider plugins...
- terraform.io/builtin/terraform is built in to Terraform

Terraform has been successfully initialized!
```

Then `terraform apply -auto-approve` and `terraform destroy -auto-approve`.
`POST`/`DELETE` locking matters most here: nothing documents whether Vercel's
edge forwards the `LOCK` and `UNLOCK` verbs, and this configuration never asks
it to.

---

## Retention does not run on its own here

Nitro's scheduler needs a process that stays alive, and a serverless function
does not. The retention task ships and is skipped: nothing prunes old versions
or sweeps orphaned blobs unless something calls it.

Trigger it externally against `POST /api/admin/retention`. It is session-guarded
like the rest of `/api/ui/*`, so a caller needs a signed-in cookie — a small
scheduled job that signs in with an operator account and posts once a day is the
straightforward approach. Vercel Cron cannot do this on its own, because it
sends an unauthenticated GET.

Until that job exists, treat `RETENTION_KEEP_VERSIONS` and
`RETENTION_KEEP_DAYS` as inert on this deployment, and expect the bucket to
grow by one object per apply forever.

---

## Limits to know about

- **Request body size.** Vercel caps the request body for serverless functions.
  A state file above that cap cannot be written, and Terraform will report the
  platform's error rather than one of ours. Large monoliths belong on the Docker
  deployment.
- **Function duration.** A very large state write plus encryption plus an S3 PUT
  has to finish inside the function timeout.
- **A held lock outlives the function.** That is correct and deliberate — the
  lock is a Postgres row, not a session — so a crashed run leaves a lock that is
  cleared with `terraform force-unlock <id>` or the dashboard's force-unlock
  button.
