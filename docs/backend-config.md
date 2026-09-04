# Backend configuration reference

Everything Terraform needs to talk to statesman, and every setting the server
reads.

---

## The backend block

```hcl
terraform {
  backend "http" {
    address        = "https://statesman.example.com/api/tf/acme/prod"
    lock_address   = "https://statesman.example.com/api/tf/acme/prod/lock"
    unlock_address = "https://statesman.example.com/api/tf/acme/prod/lock"
    lock_method    = "POST"
    unlock_method  = "DELETE"
    username       = "statesman"
  }
}
```

| Setting | Value | Why |
|---|---|---|
| `address` | `<origin>/api/tf/<org>/<project>` | GET reads state, POST writes it, DELETE purges it |
| `lock_address` | the same path plus `/lock` | POST on the base path already means "write state", so locking gets its own path |
| `unlock_address` | identical to `lock_address` | the verb distinguishes them |
| `lock_method` | `POST` | see below |
| `unlock_method` | `DELETE` | see below |
| `username` | anything; `statesman` by convention | ignored by the server, but Terraform requires a value |
| `password` | the API token | **do not put it here** — use `TF_HTTP_PASSWORD` |

### Why `POST`/`DELETE` and not `LOCK`/`UNLOCK`

`LOCK` and `UNLOCK` are the backend's defaults and are non-standard verbs
inherited from WebDAV. Whether a given CDN, ingress or serverless edge forwards
an unrecognised method is undocumented on most platforms. The `/lock` sub-path
with ordinary verbs removes that question. The server accepts all four spellings
on both paths, so a client left on the defaults still works — but nothing in
these docs depends on it.

---

## Configuration without HCL

Every backend setting has an environment variable, which is what CI should use.
`terraform init` reads them, and so does every subsequent command.

```bash
export TF_HTTP_ADDRESS="https://statesman.example.com/api/tf/acme/prod"
export TF_HTTP_LOCK_ADDRESS="$TF_HTTP_ADDRESS/lock"
export TF_HTTP_UNLOCK_ADDRESS="$TF_HTTP_ADDRESS/lock"
export TF_HTTP_LOCK_METHOD=POST
export TF_HTTP_UNLOCK_METHOD=DELETE
export TF_HTTP_USERNAME=statesman
export TF_HTTP_PASSWORD="$STATESMAN_TOKEN"   # from your CI secret store

terraform init
terraform apply -auto-approve
```

With these set, the block reduces to `backend "http" {}` and the same
configuration works for every workspace by changing one variable. This is
exactly how the acceptance suite in `tests/e2e/` drives the real CLI.

---

## Projects

A backend address only resolves for a project that already exists. Create one on
the dashboard's project list (*New Project*), which shows the finished backend
block, or over HTTP:

```bash
curl -X POST https://statesman.example.com/api/ui/projects \
  -H 'content-type: application/json' \
  -H "cookie: $SESSION" \
  -d '{"org":"acme","project":"myapp-prod"}'
```

`org` may be omitted on a single-organization deployment, which is every v1
deployment. The endpoint is guarded by a browser session, not by an API token —
Terraform tokens grant state operations, never provisioning.

| Condition | Status |
|---|---|
| Not signed in | 401 |
| Slug that is not lowercase letters, digits and dashes | 400 |
| Unknown organization, or none seeded yet | 404 |
| A project with that slug already exists in the organization | 409 |

`pnpm db:seed` does the same thing without a browser, for provisioning a
deployment from a script.

**There is no create-on-first-write, deliberately.** A typo in `address` would
otherwise create a second, empty project and split a team's state across the two
with no error anywhere. Spec §9 answers 404 for an unknown project, and that is
the behaviour worth keeping.

---

## Tokens

Minted on the **Tokens** page and shown once. Keys are stored hashed; a lost
token is replaced, not recovered.

| Control | Effect |
|---|---|
| Allowed operations | `read`, `write`, `delete`, `lock`. A `plan` needs read and lock; an `apply` needs write too |
| Project scope | *Scoped* (recommended) lists exact `org/project` pairs; *account-wide* covers every project the owner can reach |
| Expiry | Optional, up to 3650 days |
| Rate limit | Defaults to 120 requests/minute per key. One `apply` costs roughly 4–6 requests and a `plan` about 3 |
| Enabled | A kill switch that does not delete the key |

Scope matching is exact string equality on `org/project`, never a prefix test —
a token for `acme/prod` cannot reach `acme/prod-2`.

---

## Status codes

| Condition | Status | What Terraform does |
|---|---|---|
| Missing or malformed credentials | 401 | fails, reports an auth error |
| Valid token, project out of scope or action not permitted | 403 | fails |
| Unknown project | 404 | fails |
| No state stored yet | 404 | treats it as "no state", which is normal on a first run |
| Write whose `?ID=` does not match the held lock | 409 | fails |
| Lock requested while held | 423 + the holder's lock info | fails with `already locked: ID=<lock id>` |
| Storage or database failure | 500 | fails, and retries |

A 401 means the credential itself is unknown, expired, disabled or
rate-limited — never that an action was refused. A good token doing something it
may not do is a 403, so a refused `apply` does not send anyone off rotating a
working key.

---

## Server environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `STATESMAN_ENCRYPTION_KEY` | yes | — | 32 random bytes, base64. `pnpm gen:key`. **Losing it loses all state** |
| `BETTER_AUTH_SECRET` | yes | — | 32+ characters. `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | yes | — | the public origin, exactly as clients reach it |
| `DB_DRIVER` | no | `node` | `node` = `pg` pool; `neon` = `@neondatabase/serverless` HTTP |
| `STORAGE_DRIVER` | no | `local` | `local` = filesystem; `s3` = any S3-compatible endpoint |
| `LOCAL_STORAGE_PATH` | no | `./.data/state` | `local` driver only |
| `S3_BUCKET` | when `s3` | — | startup fails without it |
| `S3_ENDPOINT` | no | AWS | set for MinIO, R2, B2 |
| `S3_REGION` | no | `us-east-1` | |
| `S3_FORCE_PATH_STYLE` | no | `false` | `true` for MinIO |
| `S3_ACCESS_KEY_ID` | no | — | omit both to use the AWS default credential chain (instance role, SSO) |
| `S3_SECRET_ACCESS_KEY` | no | — | |
| `RETENTION_KEEP_VERSIONS` | no | `100` | |
| `RETENTION_KEEP_DAYS` | no | `30` | a version is pruned only when it is past **both** |
| `STATESMAN_ORG_SLUG` | no | `acme` | `pnpm db:seed` only |
| `STATESMAN_SEED_PROJECTS` | no | `prod` | `pnpm db:seed` only; comma-separated |

Booleans accept `true`/`false`/`1`/`0`/`yes`/`no`. An empty value means "unset"
and falls back to the default; anything unparseable is rejected by name at
startup rather than silently treated as true.

`STORAGE_DRIVER=local` on a serverless platform is refused at boot. That
filesystem is ephemeral, so it would appear to work in testing and lose every
state file on the next cold start.
