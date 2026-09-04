# statesman — Design Spec

**Date:** 2026-09-04
**Status:** Approved for planning

A self-hostable Terraform/OpenTofu HTTP state backend with encrypted state at
rest, full version history, and scoped API tokens.

---

## 1. Problem

Terraform's `s3` backend is the default answer for remote state and it is a good
one. It has three gaps that matter to us:

1. **Every actor needs AWS credentials.** Each developer and each CI runner must
   hold IAM credentials just to read state. Issuing and rotating those is
   friction, and their blast radius is larger than "read one state file".
2. **State is readable by whoever holds the bucket.** S3 server-side encryption
   is decrypted transparently for any principal with `s3:GetObject`. State files
   contain plaintext provider credentials, database passwords, and private keys.
3. **History is technically present but practically unusable.** S3 object
   versioning stores prior states, but there is no way to see who applied a
   change, when, or what changed between two versions.

statesman closes those three gaps. It is not trying to be Terraform Cloud: no
remote execution, no policy engine, no billing.

### Non-goals

- Remote `terraform plan`/`apply` execution
- Policy-as-code (OPA/Sentinel)
- Drift detection
- Editing state through the UI
- Multi-organization tenancy in v1 (see §5)

---

## 2. The Terraform HTTP backend protocol

The server implements Terraform's `http` backend. The full protocol is five
operations on a single URL.

| Path | Method | Meaning | Success | Notes |
|---|---|---|---|---|
| `/api/tf/:org/:project` | `GET` | Fetch current state | 200 | 404 when no state exists yet — normal, not an error |
| `/api/tf/:org/:project` | `POST` | Write new state | 200 | Carries `?ID=<lock-id>` when a lock is held |
| `/api/tf/:org/:project` | `DELETE` | Purge state | 200 | |
| `/api/tf/:org/:project` | `LOCK` / `UNLOCK` | Acquire / release lock | 200 | Accepted for compatibility; see below |
| `/api/tf/:org/:project/lock` | `POST` / `LOCK` | Acquire lock | 200 | 423 when already held |
| `/api/tf/:org/:project/lock` | `DELETE` / `UNLOCK` | Release lock | 200 | |

`POST` is overloaded by path, not by verb: on the base path it writes state, on
`/lock` it acquires a lock. This is why locking gets its own sub-path — it lets
a client that cannot send `LOCK` still distinguish the two operations.

Client configuration:

```hcl
terraform {
  backend "http" {
    address        = "https://statesman.example.com/api/tf/acme/myapp-prod"
    lock_address   = "https://statesman.example.com/api/tf/acme/myapp-prod/lock"
    unlock_address = "https://statesman.example.com/api/tf/acme/myapp-prod/lock"
    lock_method    = "POST"
    unlock_method  = "DELETE"
    username       = "statesman"
    password       = "<api key>"
  }
}
```

### Decision: do not depend on the `LOCK`/`UNLOCK` verbs

`LOCK` and `UNLOCK` are non-standard HTTP methods inherited from WebDAV. Nitro
handles arbitrary verbs via `event.method`, but whether Vercel's edge proxy
forwards them is undocumented — no authoritative source states it either way.

Rather than resolve that empirically and depend on unversioned platform
behaviour, the server exposes locking on a dedicated `/lock` sub-path that
accepts `POST` (acquire) and `DELETE` (release). It **also** accepts `LOCK` and
`UNLOCK` on both paths, so a client configured either way works. Documentation
recommends the `POST`/`DELETE` form.

This removes the platform risk entirely at the cost of two extra lines in the
router.

---

## 3. Architecture

```
Terraform CLI ──Basic Auth (API key as password)──┐
                                                  ├──► Nuxt 4 / Nitro
Browser ──────Better Auth session cookie──────────┘         │
                                                            ├──► Postgres   (metadata, locks, auth, audit)
                                                            └──► Blob store (encrypted state bytes)
```

A single Nuxt 4 application serves both the web UI and the Terraform protocol
endpoints. Two authentication paths converge on one authorization model.

**Postgres is the source of truth.** It is the only component that decides lock
ownership and which state version is current. The blob store holds opaque
encrypted bytes and is never consulted for correctness decisions.

### Why the split

State blobs can reach tens of megabytes. Storing them in Postgres bloats backups
and WAL. Storing metadata in the blob store makes queries (history, audit,
"which projects exist") impossible without listing objects. The split gives
cheap queries and cheap bytes.

---

## 4. Authentication and authorization

### Two doors

Better Auth is a browser-session library. The Terraform CLI cannot perform an
OAuth or cookie flow — it sends only HTTP Basic Auth or a client certificate.
These are genuinely different mechanisms and the design treats them as such.

| Actor | Mechanism | Guards |
|---|---|---|
| Human | Better Auth session cookie | Web UI, token management |
| Terraform CLI | API key in Basic Auth password field | `/api/tf/*` |

### Who may hold an account, and what an account can see

**There is no public sign-up.** `emailAndPassword.disableSignUp` is set, so
`POST /api/auth/sign-up/email` is refused — including through the server-side
API. Accounts are created by the operator with `pnpm user:create`, which needs
database access and `BETTER_AUTH_SECRET`.

That control is load-bearing, because **every authenticated user can see every
project**: the project list, the version timeline, the decrypted diff, force
unlock, rollback, and token creation are all guarded by "is there a session",
nothing finer. There is no per-user ACL, no roles, and no ownership.

This is deliberate rather than unfinished. One deployment serves one
organization (§5), so the set of accounts *is* the set of people trusted with
that organization's state — which is how a self-hosted team tool should behave,
and it keeps the authorization surface small enough to reason about. It is only
safe while account creation is closed, which is why the two decisions belong in
the same section.

**The consequence an operator must know:** creating an account grants read
access to the plaintext of every state file in the deployment, including the
provider credentials and database passwords inside them. Do not create accounts
for people who should see only some projects; run a second deployment instead.

They meet at Better Auth's **API Key plugin**, which provides
`auth.api.verifyApiKey({ key, permissions })` — a server-side call that accepts
a raw key string. The Terraform request handler decodes the `Authorization:
Basic` header, takes the password component, and passes it to that call. The
username component is ignored (Terraform requires *something* there; we
document `statesman`).

Keys are stored hashed. The raw value is shown exactly once, at creation.

### Token configurator

The UI exposes a builder mapping onto plugin fields:

| Control | Field |
|---|---|
| Allowed operations (read / write / delete / lock) | `permissions: { state: [...] }` |
| Project scope | `metadata: { scope: TokenScope }` |
| Expiry | `expiresIn` |
| Rate limit | `rateLimitMax`, `rateLimitTimeWindow` |

Revocation is deletion, and it takes effect on the next request. The plugin's
`enabled` column would allow a reversible disable, but nothing sets it and no UI
offers it, so it is not claimed as a feature.

Two presets are offered, both producing the same token shape:

- **Scoped** (recommended, default) —
  `metadata.scope = { kind: 'projects', projects: ['acme/myapp-prod'] }`
- **Account-wide** — `metadata.scope = { kind: 'all' }`, which is every project
  in the deployment. An earlier draft said "limited to projects the owning user
  can access", which implied a per-user ACL that does not exist: `scopeAllows`
  returns true unconditionally for this scope, and under one organization per
  deployment every user can reach every project anyway. The wording is corrected
  rather than the behaviour, because the behaviour is the intended model — see
  "Who may hold an account" above.

`TokenScope` is a discriminated union defined once in `shared/schemas/token.ts`
and imported by both the configurator and the guard. An earlier draft of this
document described a flat `{ projects: string[] | "*" }`; the union is what is
implemented, because it makes "all projects" and "no projects" distinguishable —
a flat `[]` is ambiguous between the two, and the guard must fail closed on the
second.

### Known gap: project scoping is ours to enforce

Better Auth's `permissions` field is resource→actions, not resource→instances.
It can express "this key may write state" but not "…only for project X".

Project scope therefore lives in `metadata.scope` and is enforced by our own
middleware, not by the plugin. This is roughly ten lines, and it is
security-critical code: it must be centralised in a single guard that every
`/api/tf/*` request passes through, never re-implemented per route. It gets
direct unit tests including the deny cases.

---

## 5. Data model

Better Auth owns `user`, `session`, `account`, `verification`, and `apikey`.
Application tables:

```
organization   id, name, slug, created_at

project        id, org_id → organization, name, slug, created_at
               UNIQUE (org_id, slug)

state_version  id (ULID), project_id → project, serial, lineage,
               size_bytes, md5, blob_key, created_by → user, created_at
               INDEX (project_id, created_at DESC)

project_state  project_id PK → project, current_version_id → state_version
               -- the pointer; one row per project

state_lock     project_id PK → project, lock_id, who, operation,
               version, created_at, info_json
               -- row exists ⇔ lock held

audit_log      id, org_id, project_id, actor_type, actor_id,
               action, meta_json, at
```

### Single organization, multi-org-ready

v1 runs one organization per deployment. A single row is seeded at first boot.

`org_id` exists on `project` and is carried in token metadata from day one. This
makes a future move to Better Auth's organization plugin an additive change — a
plugin, a UI screen, and a scoping change — rather than a schema migration
across every table. The column costs nothing now.

---

## 6. Storage abstraction

One interface, selected by `STORAGE_DRIVER`:

```ts
interface StateStore {
  put(key: string, data: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}
```

| Driver  | Implementation | Target |
|---------|----------------|--------|
| `s3`    | `@aws-sdk/client-s3` | Vercel; S3, R2, MinIO, B2, any S3-compatible endpoint |
| `local` | `node:fs/promises`   | Docker Compose, homelab |

Blob keys are `${org}/${project}/${versionId}.tfstate.enc`. Keys are never
reused and objects are never overwritten.

### Boot-time validation

`STORAGE_DRIVER=local` combined with a detected serverless environment
(`process.env.VERCEL`) fails at startup with an explicit message. Vercel's
filesystem is ephemeral; silently discarding state on the next cold start would
be the most damaging possible failure, and it would appear to work in testing.

---

## 7. Database abstraction

Drizzle ORM against Postgres. One schema, two drivers selected by `DB_DRIVER`:

| Driver | Package | Target |
|--------|---------|--------|
| `neon` | `@neondatabase/serverless` | Vercel — HTTP transport, no TCP pool |
| `node` | `pg` Pool | Docker Compose, any long-lived Node process |

Drizzle's schema definitions and query builder are identical across both. Only
the connection factory differs, isolated in one module. Migrations are
`drizzle-kit` SQL files, applied by a startup command in Docker and by a
predeploy step on Vercel.

---

## 8. Encryption at rest

`STATESMAN_ENCRYPTION_KEY` is **required**. The server refuses to start without
it.

- AES-256-GCM, via `node:crypto`
- 32-byte key, base64-encoded in the environment variable
- Random 96-bit IV per object, stored as a prefix on the ciphertext
- Auth tag appended; a tampered blob fails to decrypt rather than returning
  corrupt state
- Encryption happens before the `StateStore` is called; the store only ever sees
  ciphertext

A `pnpm gen:key` script emits a correctly-sized key.

### Why this is mandatory, not optional

State files contain plaintext secrets. Making encryption opt-in means most
deployments will not have it, which removes the primary reason to run statesman
over plain S3. A required key is a small amount of one-time setup friction in
exchange for making a leaked bucket or a stolen disk worthless.

**Consequence, documented prominently:** losing the key means losing all state.
Key rotation is a v2 concern; v1 documents backing the key up alongside — but
not inside — the database backup.

---

## 9. Request flow

### `POST` (write state)

1. Decode Basic Auth, `verifyApiKey`, resolve owning user
2. Resolve `:org/:project`; 404 if unknown
3. Check `metadata.projects` scope; 403 on miss
4. Check `permissions.state` includes `write`; 403 on miss
5. If a lock row exists, require `?ID=` to match `lock_id`; 409 on mismatch
6. Encrypt the body
7. `put` ciphertext under a new ULID key
8. `INSERT` the `state_version` row
9. `UPDATE` the `project_state` pointer
10. `INSERT` an `audit_log` row

Steps 7–9 are ordered so that a failure after the blob write leaves an orphaned,
unreferenced blob rather than a pointer to a nonexistent object. Orphans are
harmless and swept by the retention job. **A dangling pointer would be data
loss; an orphan blob is wasted bytes.** The ordering is deliberate and must not
be changed for convenience.

### Locking

`INSERT INTO state_lock ... ON CONFLICT (project_id) DO NOTHING`, then check the
affected row count.

- 1 row → lock acquired
- 0 rows → held; `SELECT` the existing row and return **423** with its
  `info_json` so Terraform can report who holds it

Postgres advisory locks are explicitly rejected: they are bound to a session and
release when the connection drops, which is wrong under serverless where
connections are short-lived and unpredictable. A plain row with a uniqueness
constraint is atomic, driver-agnostic, and survives process death — a held lock
outliving a crashed process is the correct behaviour, and is resolved the same
way Terraform already handles it, with `force-unlock`.

Force-unlock is exposed in the UI, gated on session auth, and always audited.

---

## 10. Version history and retention

Every write creates an immutable `state_version`. The UI provides:

- A timeline per project: serial, actor, timestamp, size
- A diff between any two versions, rendered from decrypted JSON
- One-click rollback (which writes a *new* version whose content matches an old
  one — history is never rewritten)

Retention defaults to **keep the last 100 versions, and everything from the last
30 days, whichever is greater**. Both are configurable. A scheduled job prunes
older versions and their blobs, and sweeps orphaned blobs.

The current version is never pruned.

---

## 10b. Startup validation

The process validates itself at boot rather than discovering problems on the first
request. Two tiers, because they fail for different reasons.

### Tier 1 — configuration. Always fatal.

`server/plugins/00.env.ts` runs `env()` at Nitro startup, which Zod-parses
`process.env` against the full schema. A missing `STATESMAN_ENCRYPTION_KEY`, a key
that is not 32 bytes, `STORAGE_DRIVER=s3` without a bucket, or `STORAGE_DRIVER=local`
on a serverless platform all exit the process with code 1 before a port is bound.

Configuration errors are deterministic: retrying changes nothing, and a server that
accepts traffic it cannot serve is worse than one that never started.

### Tier 2 — connectivity. Fatal only on a long-running server.

Four probes, in order:

1. **Encryption key round-trip** — `open(key, seal(key, probe)) === probe`. Catches a
   corrupt or truncated key before it silently encrypts state that cannot be read back.
2. **Database reachable** — `SELECT 1`.
3. **Migrations applied** — the `organization` table exists. Catches a deploy that
   skipped `drizzle-kit migrate`, which is otherwise a confusing runtime error on the
   first dashboard load.
4. **Blob store writable** — put, get, and delete a probe object under
   `.statesman-healthcheck/<ulid>`. A read-only check would pass for credentials that
   can list but not write, which is precisely the failure that appears at the first
   `terraform apply` rather than at deploy time.

**On a long-running server** (`IS_SERVERLESS === false`) a failed probe exits the
process. The container dies loudly, the orchestrator reports it, and the deploy is
visibly broken instead of quietly half-working.

**On serverless** (`IS_SERVERLESS === true`) the probes are skipped entirely.
Serverless functions cold-start constantly, and Neon scales to zero — a database
round-trip on every cold start would add latency to every request path and convert a
brief upstream blip into a hard outage. The `/api/health` endpoint still runs the same
probes on demand, so the information remains available without gating startup.

### `GET /api/health`

Unauthenticated. Runs the Tier 2 probes and returns `200` with
`{ status: 'ok', checks: { … } }`, or `503` with per-check detail when any fails.
It reports check names and pass/fail only — never connection strings, bucket names,
or key material, because it is reachable without credentials.

Used by the Docker healthcheck and by load balancers.

## 11. Error responses

| Condition | Status |
|---|---|
| Missing or malformed credentials | 401 |
| Valid key, project out of scope, or missing permission | 403 |
| Unknown project | 404 |
| No state stored yet | 404 |
| Write whose lock ID does not match the held lock | 409 |
| Lock requested while held | 423 + lock info JSON |
| Storage or database failure | 500 |

Terraform treats any non-2xx as an error except the 404-on-empty-state case,
which it handles as "no state yet". 423 and 409 bodies must contain the lock
info JSON or Terraform cannot tell the user who holds the lock.

---

## 12. Validation

Zod 4.5 at every boundary:

- Environment variables, parsed once at boot; the process refuses to start on a
  bad config rather than failing at first request
- Terraform lock-info request bodies
- All UI-facing API input
- Token configurator form input, with the same schema shared by client and
  server

Validation is bound to the read, never performed after it. Every handler uses h3's
validated request utilities — `readValidatedBody`, `getValidatedQuery`,
`getValidatedRouterParams` — each taking the Zod schema directly. Reading a
boundary with `readBody` or `getQuery` and validating separately is not
permitted: it makes skipping validation a silent omission rather than a visible
one.

Two consequences follow from h3's implementation:

- `validateData` catches whatever a validator throws and re-raises it as
  `400 Validation Error`. A handler that owes a different status per §11 — an
  unknown project is 404, not 400 — wraps the call and rethrows. Throwing the
  intended status from inside the validator does not work; it is swallowed.
- Zod is not applied to state file contents. State is an opaque blob defined by
  Terraform, and validating its shape would couple us to Terraform's internal
  format across versions. The state body is read with `readRawBody`. We parse
  `serial` and `lineage` opportunistically for display only, and tolerate their
  absence.

---

## 13. Testing

Test-first, per project convention.

1. **Protocol tests** (Vitest, handler invoked directly)
   - Full cycle: lock → write → read → unlock
   - `GET` with no state returns 404
   - Write without the matching lock ID returns 409
   - Concurrent lock attempts: exactly one succeeds, the other gets 423
   - Every authorization deny path: no key, expired key, disabled key,
     out-of-scope project, missing permission

2. **Adapter conformance tests**
   - One shared suite run against both storage drivers (local fs, MinIO)
   - One shared suite run against both database drivers (`pg`, Neon)
   - Round-trip encryption, including tamper detection

3. **End-to-end against real Terraform** (Docker Compose)
   - Real `terraform init`, `apply`, `destroy` against a running server
   - This is the acceptance test. Unit tests can agree with each other and still
     be wrong about the protocol; only the real CLI settles it.

---

## 14. Deployment

**Local development** — `docker-compose.yml`: app, Postgres, MinIO. One
`docker compose up`, seeded org, working example Terraform config in
`examples/`.

**Self-hosted production** — `docker-compose.prod.yml`: app and Postgres, with
storage pointed at an external S3-compatible endpoint. Healthchecks, restart
policies, and a migration step that runs before the app accepts traffic.

**Vercel** — `vercel.json`, `DB_DRIVER=neon`, `STORAGE_DRIVER=s3`. Documented
environment variables and a predeploy migration step.

All three are covered by documentation with copy-pasteable configuration.

---

## 15. Stack

| Concern | Choice | Version |
|---|---|---|
| Framework | Nuxt | 4.5.2 |
| UI | Nuxt UI | 4.11.0 |
| Validation | Zod | 4.5.4 |
| Auth | Better Auth + API Key plugin | 1.7.2 |
| ORM | Drizzle | 0.45.2 |
| DB driver (serverless) | `@neondatabase/serverless` | 1.1.0 |
| DB driver (node) | `pg` | 8.23.0 |
| Runtime | Node | 24.4.1 |
| Package manager | pnpm | 10.17.1 |

Versions verified against the npm registry on 2026-09-04.
