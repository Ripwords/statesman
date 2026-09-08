import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $fetch, url as absoluteUrl, useTestContext } from '@nuxt/test-utils/e2e'
import { auth } from '../../server/utils/auth'
import type { StateStore } from '../../server/storage/types'
import { listVersions } from '../../server/services/state'
import { seedOrg, resetDb, provisionUser } from '../protocol/helpers'

const FIXTURE = fileURLToPath(new URL('fixture', import.meta.url))
const PROJECT = 'prod'
const HOLDER = 'another-engineer@laptop'
const HOLDER_LOCK_ID = 'held-by-test'

type TerraformRun = { code: number; stdout: string; stderr: string; combined: string }

/**
 * Runs the CLI and returns its exit code rather than throwing on a non-zero
 * one. Several of the assertions below are about what Terraform PRINTS when it
 * fails, and a promisified execFile hides that behind a rejection whose shape
 * has to be re-narrowed anyway. A spawn failure — no terraform on PATH — is
 * still a rejection, because that is a broken test environment and not a result.
 */
function terraform(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<TerraformRun> {
  return new Promise((resolve, reject) => {
    execFile(
      'terraform',
      args,
      { cwd: options.cwd, env: options.env, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const combined = `${stdout}\n${stderr}`
        if (error) {
          if (typeof error.code === 'string') {
            reject(new Error(`could not run terraform (${error.code}): ${error.message}`))
            return
          }
          resolve({ code: error.code ?? 1, stdout, stderr, combined })
          return
        }
        resolve({ code: 0, stdout, stderr, combined })
      }
    )
  })
}

export type ScenarioOptions = {
  /**
   * The organization slug this run owns. Suites share one database and one blob
   * root and are separated by slug, not serialised — see tests/protocol/helpers.
   */
  org: string
  /** Named in the describe block: which storage driver the server is running. */
  driver: string
  /**
   * The store the SERVER under test writes to. It is not necessarily the one
   * this process is configured for — resetDb only reaches the latter — so the
   * blobs have to be cleared and inspected through this handle.
   */
  store: StateStore
}

/**
 * The acceptance test. Everything else in this repo checks our beliefs about
 * the Terraform HTTP protocol against each other; this checks them against
 * Terraform.
 *
 * Backend settings arrive as TF_HTTP_* environment variables rather than
 * `-backend-config`, because the http backend reads them for every command and
 * not just `init` — so the lock and unlock addresses are in force for the
 * apply that has to fail.
 */
export function terraformAcceptance(options: ScenarioOptions): void {
  let dir: string
  let token: string
  let projectId: string

  const base = (): string => {
    const { url } = useTestContext()
    if (!url) throw new Error('the test server has no URL')
    return url.replace(/\/$/, '')
  }

  const address = (): string => `${base()}/api/tf/${options.org}/${PROJECT}`

  const tf = (...args: string[]): Promise<TerraformRun> =>
    terraform(args, {
      cwd: dir,
      env: {
        ...process.env,
        TF_IN_AUTOMATION: '1',
        TF_INPUT: '0',
        // Keeps the run entirely offline: no version check, no telemetry.
        CHECKPOINT_DISABLE: '1',
        TF_HTTP_ADDRESS: address(),
        TF_HTTP_LOCK_ADDRESS: `${address()}/lock`,
        TF_HTTP_UNLOCK_ADDRESS: `${address()}/lock`,
        // Spec §2: the POST/DELETE spelling, which is what the README documents
        // and the only one that does not depend on a proxy forwarding the
        // WebDAV-inherited LOCK verb.
        TF_HTTP_LOCK_METHOD: 'POST',
        TF_HTTP_UNLOCK_METHOD: 'DELETE',
        TF_HTTP_USERNAME: 'statesman',
        TF_HTTP_PASSWORD: token
      }
    })

  const basicAuth = (): string => `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}`

  const asHolder = (method: 'POST' | 'DELETE'): Promise<unknown> =>
    $fetch(`/api/tf/${options.org}/${PROJECT}/lock`, {
      method,
      headers: { authorization: basicAuth() },
      body: { ID: HOLDER_LOCK_ID, Who: HOLDER, Operation: 'OperationTypeApply' }
    })

  describe(`real terraform against the ${options.driver} storage driver`, () => {
    beforeAll(async () => {
      await resetDb(options.org)
      for (const key of await options.store.list(`${options.org}/`)) {
        await options.store.delete(key)
      }
      // The ORGANIZATION is provisioned once per deployment (spec §5). The
      // PROJECT is not seeded here on purpose: it is created below through the
      // same dashboard endpoint an operator uses, so this run proves a freshly
      // deployed statesman is usable without anyone shelling in.
      await seedOrg(options.org)

      const email = `tf-${options.driver}-${Date.now()}@example.com`
      const password = 'correct horse battery'
      // Created through the operator path, because the server refuses public
      // sign-up. This also proves an operator-provisioned account can sign in
      // against the running server, which is the whole point of the split.
      // Admin: the acceptance run creates its own project through the dashboard
      // endpoint, which is admin-only.
      const user = await provisionUser(email, password, 'admin')

      // A real browser session, taken over HTTP, because that is what guards
      // the create endpoint.
      const signIn = await fetch(absoluteUrl('/api/auth/sign-in/email'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      await signIn.text()
      const cookie = signIn.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ')

      const created = await $fetch('/api/ui/projects', {
        method: 'POST',
        headers: { cookie },
        body: { org: options.org, project: PROJECT }
      })
      expect(created).toMatchObject({ org: options.org, slug: PROJECT })
      projectId = created.id

      const key = await auth.api.createApiKey({
        body: {
          userId: user.id,
          name: `terraform-e2e-${options.driver}`,
          permissions: { state: ['read', 'write', 'delete', 'lock'] },
          metadata: { scope: { kind: 'projects', projects: [`${options.org}/${PROJECT}`] } }
        }
      })
      token = key.key

      dir = await mkdtemp(join(tmpdir(), `statesman-tf-${options.driver}-`))
      await cp(FIXTURE, dir, { recursive: true })
    })

    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('initialises against a project created through the dashboard api', async () => {
      const run = await tf('init', '-no-color')
      expect(run.combined).toContain('Terraform has been successfully initialized')
      expect(run.code).toBe(0)
    })

    it('applies and persists state', async () => {
      const applied = await tf('apply', '-auto-approve', '-no-color')
      expect(applied.combined).toContain('Apply complete')
      expect(applied.code).toBe(0)

      const read = await tf('output', '-raw', 'value')
      expect(read.stdout.trim()).toBe('one')
      expect(read.code).toBe(0)
    })

    it('reads the same state back in a fresh plan', async () => {
      // Terraform caches nothing between commands here: this plan re-fetches
      // the state over HTTP and decrypts it server-side. -detailed-exitcode
      // makes "no changes" an exit code rather than a string match alone.
      const run = await tf('plan', '-no-color', '-detailed-exitcode')
      expect(run.combined).toContain('No changes')
      expect(run.code).toBe(0)
    })

    it('records a new version on the next apply without rewriting history', async () => {
      const before = await listVersions(projectId, 500)
      expect(before.length).toBeGreaterThan(0)

      const applied = await tf('apply', '-auto-approve', '-no-color', '-var', 'value=two')
      expect(applied.code).toBe(0)

      const read = await tf('output', '-raw', 'value')
      expect(read.stdout.trim()).toBe('two')

      // Spec §10: every write is an immutable version and nothing is rewritten,
      // so the earlier ids must all still be there alongside the new one.
      const after = await listVersions(projectId, 500)
      expect(after.length).toBeGreaterThan(before.length)
      const ids = new Set(after.map((v) => v.id))
      expect(before.every((v) => ids.has(v.id))).toBe(true)
    })

    it('stores every blob under the org/project prefix the sweep looks for', async () => {
      // The retention sweep finds orphans by listing `<org>/<project>/`, and the
      // two drivers implement that listing through entirely different code — a
      // recursive readdir against a path prefix, versus ListObjectsV2 paging on
      // a key prefix. A blob written outside the prefix would be invisible to
      // the sweep and accumulate forever, which no unit test would notice.
      const keys = await options.store.list(`${options.org}/${PROJECT}/`)
      expect(keys.length).toBeGreaterThanOrEqual(2)
      for (const key of keys) {
        expect(key).toMatch(
          new RegExp(`^${options.org}/${PROJECT}/[0-9A-HJKMNP-TV-Z]{26}\\.tfstate\\.enc$`)
        )
      }
      // Encryption is not optional (spec §8): what landed must not be readable.
      const first = keys[0]
      if (!first) throw new Error('no blob was written')
      const bytes = await options.store.get(first)
      if (!bytes) throw new Error(`blob ${first} disappeared`)
      expect(Buffer.from(bytes).toString('utf8')).not.toContain('terraform_data')
    })

    /**
     * The assertion that matters most in this file, and the one the brief got
     * wrong. It expected Terraform's error to print the holder's name. It does
     * not, and it cannot: `httpClient.Lock` returns
     * `&statemgr.LockError{Info: info, Err: ...}` where `info` is the CALLER's
     * own lock info, and folds only `existing.ID` — from our response body —
     * into the message as `already locked: ID=%s`. So the "Lock Info:" block
     * Terraform prints is always about the process that just failed, and Who
     * never crosses the wire into the CLI. Verified against terraform 1.14.9.
     *
     * `ID=<holder's lock id>` is therefore the whole of what the CLI surfaces,
     * and it is still the discriminator the brief was reaching for: the two
     * ways to get this wrong both empty it out. Wrap the body in h3's error
     * envelope and `json.Unmarshal` into a LockInfo finds no top-level ID, so
     * the message reads `ID=` and the lock appears to be held by nobody. Answer
     * 405 to the verb the backend advertises and there is no 423 at all.
     *
     * The holder's identity does exist in the response, so the dashboard's lock
     * banner and `terraform force-unlock` both have what they need — that is
     * what the raw-body assertion below covers, at the layer where it is true.
     */
    it('reports the holder to terraform when the state is already locked', async () => {
      await asHolder('POST')
      try {
        const conflict = await fetch(absoluteUrl(`/api/tf/${options.org}/${PROJECT}/lock`), {
          method: 'POST',
          headers: { authorization: basicAuth(), 'content-type': 'application/json' },
          body: JSON.stringify({ ID: 'a-second-engineer', Who: 'someone-else@ci' })
        })
        expect(conflict.status).toBe(423)
        // Parsed from the raw bytes, because that is what Go does with them.
        const body: unknown = JSON.parse(await conflict.text())
        expect(body).toMatchObject({ ID: HOLDER_LOCK_ID, Who: HOLDER })

        const run = await tf('apply', '-auto-approve', '-no-color')

        // Asserting on `combined` rather than a parsed field is deliberate: a
        // failure here prints the CLI's entire output in the diff, which is the
        // only place the real evidence lives. Vitest's default reporter hides
        // console output from passing tests, so printing it unconditionally
        // would be dead code.
        expect(run.code).not.toBe(0)
        expect(run.combined).toContain('Error acquiring the state lock')
        expect(run.combined).toContain(`already locked: ID=${HOLDER_LOCK_ID}`)
      } finally {
        // Outside the assertions: a lock left behind here fails every test after
        // it and buries the one real failure under three cascading ones.
        await asHolder('DELETE')
      }
    })

    it('recovers once the lock is released', async () => {
      // -var value=two matches what the last successful apply stored: exit 0
      // means the state survived the failed run intact and is readable again.
      const run = await tf('plan', '-no-color', '-detailed-exitcode', '-var', 'value=two')
      expect(run.combined).toContain('No changes')
      expect(run.code).toBe(0)
    })

    it('destroys cleanly', async () => {
      const run = await tf('destroy', '-auto-approve', '-no-color', '-var', 'value=two')
      expect(run.combined).toContain('Destroy complete')
      expect(run.code).toBe(0)
    })
  })
}
