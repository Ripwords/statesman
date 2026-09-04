# Deploying with Docker Compose

`docker-compose.prod.yml` runs the app and a Postgres, with state on a named
volume or an external S3-compatible bucket. The steps below were run end to end
against this file; the output quoted is real.

---

## 1. Configure

```bash
cp .env.prod.example .env.prod
pnpm gen:key                  # → STATESMAN_ENCRYPTION_KEY
openssl rand -base64 32       # → BETTER_AUTH_SECRET
openssl rand -base64 24       # → POSTGRES_PASSWORD
```

Fill in `.env.prod`. Compose reads it for interpolation only; the app's own
environment is assembled inside the compose file.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `POSTGRES_PASSWORD` | **yes** | — | also the password in the derived `DATABASE_URL` |
| `STATESMAN_ENCRYPTION_KEY` | **yes** | — | 32 bytes base64. **[Back this up separately from the database.](../README.md#back-up-statesman_encryption_key-separately-from-the-database)** |
| `BETTER_AUTH_SECRET` | **yes** | — | 32+ characters |
| `BETTER_AUTH_URL` | **yes** | — | the public origin, exactly as browsers and Terraform reach it |
| `POSTGRES_USER` | no | `statesman` | |
| `POSTGRES_DB` | no | `statesman` | |
| `DATABASE_URL` | no | derived from the three above, pointing at the `postgres` service | set it to use a managed database, and delete the `postgres` service |
| `PORT` | no | `3000` | host port |
| `STORAGE_DRIVER` | no | `local` | `local` uses the `statedata` volume |
| `S3_BUCKET` | when `s3` | — | |
| `S3_ENDPOINT` | no | AWS | set for MinIO, R2, B2 |
| `S3_REGION` | no | `us-east-1` | |
| `S3_FORCE_PATH_STYLE` | no | `false` | `true` for MinIO |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | no | — | omit both to use the AWS default credential chain |
| `RETENTION_KEEP_VERSIONS` | no | `100` | |
| `RETENTION_KEEP_DAYS` | no | `30` | |

The four required variables use compose's `${VAR:?}` form, so a missing one
fails the deployment before anything starts:

```
$ docker compose -f docker-compose.prod.yml config
error while interpolating services.postgres.environment.POSTGRES_PASSWORD:
required variable POSTGRES_PASSWORD is missing a value: POSTGRES_PASSWORD is required
```

That is the intended behaviour, not a broken file. Pass `--env-file .env.prod`
and it resolves.

## 2. Start

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Three things happen in order, enforced by `depends_on`:

1. **postgres** starts and becomes healthy.
2. **migrate** runs `drizzle-kit migrate` and exits 0. It runs from the build
   stage of the same Dockerfile, which is where drizzle-kit, `drizzle.config.ts`
   and the SQL files live — the runtime image carries none of them, so there is
   no network fetch at deploy time.
3. **app** starts only once migrate has completed successfully.

## 3. Seed the organization

The organization is a deployment-level thing (spec §5) and nothing in the app
creates one, so it has to be seeded once before anybody can sign in:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  run --rm migrate pnpm db:seed
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

Seeding remains the non-interactive route, for provisioning from a script:
add `-e STATESMAN_SEED_PROJECTS=prod,staging,sandbox` to the command above. It
is a no-op per row, so it is safe to re-run.

## 4. Verify

```bash
$ curl -s http://localhost:3000/api/health
{"status":"ok","checks":[{"name":"encryption","ok":true,"ms":0},
{"name":"database","ok":true,"ms":0},{"name":"migrations","ok":true,"ms":1},
{"name":"storage","ok":true,"ms":1}]}
```

All four probes must pass. `storage` is a real put/get/delete against the
configured store, so it catches a volume the container cannot write to and
credentials that can list but not write — the failure that otherwise shows up at
the first `terraform apply` rather than at deploy time. The container's own
healthcheck runs the same endpoint, so `docker compose ps` reports `(healthy)`
only when state can actually be stored.

Then create your account — there is no sign-up page, by design:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  run --rm migrate pnpm user:create you@example.com "Your Name"
```

```
Created user: you@example.com
Password: <printed once>
Shown once. Sign in and change it, or store it in a password manager.
```

Pass `-e STATESMAN_USER_PASSWORD=…` to choose the password instead of having one
generated. The command needs `DATABASE_URL` and `BETTER_AUTH_SECRET`, which the
migrate service has, and deliberately not the encryption key.

> **Every account you create can read every project**, including the decrypted
> plaintext of every state file. There are no roles and no per-project
> permissions — see the README. Give people accounts accordingly.

Now sign in at the app's URL, mint a token on the **Tokens** page, and run the
real thing:

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

`terraform apply -auto-approve` then `terraform destroy -auto-approve` completes
the round trip. `terraform_data` is built into Terraform core, so this needs no
provider and no cloud credentials.

---

## Operating notes

- **Backups.** Back up the Postgres volume *and* the state blobs (the
  `statedata` volume, or the bucket). Back up `STATESMAN_ENCRYPTION_KEY`
  somewhere neither of those backups reaches — a backup holding both the
  ciphertext and its key defeats the encryption entirely.
- **Upgrades.** `docker compose --env-file .env.prod -f docker-compose.prod.yml
  up -d --build` re-runs migrate before the new app starts. The old container
  keeps serving until then.
- **The database is not published.** The `postgres` service has no host ports;
  it is reachable only on the compose network.
- **The app runs unprivileged.** `/data/state` is created in the image and owned
  by the `app` user so the named volume inherits that ownership; a volume
  created at mount time would belong to root and every write would fail with
  `EACCES`.
- **Behind a proxy**, set `BETTER_AUTH_URL` to the public origin and forward a
  trusted client IP header — otherwise Better Auth logs a warning and rate
  limits fall back to one shared bucket per path.
- **Retention runs itself here.** Nitro's scheduler fires the task at 03:17
  daily inside the app container, pruning versions past both thresholds and
  sweeping orphaned blobs. `POST /api/admin/retention` runs a pass on demand.
- **Uptime checks** may use `HEAD /api/health`; it answers 200 like `GET`.
