/**
 * Test runs must never touch the database or blob store you develop against.
 *
 * Before this existed, `pnpm test` wrote into the same Postgres as `pnpm dev`:
 * every suite seeds its own organization and `resetDb` clears that organization
 * on the way IN, never on the way out, so a run left eight fake projects, six
 * sign-in-able accounts and ten live API tokens sitting in the dashboard. The
 * accounts and keys were never cleaned at all — `resetDb` deliberately leaves
 * `user` alone because the endpoint suite's key hangs off one.
 *
 * Cleaning up afterwards would have been the smaller change and the wrong one:
 * a crashed suite still leaks, and suites run in parallel so a global sweep can
 * delete a sibling's fixtures mid-run. Separate databases make the collision
 * impossible instead of merely tidy.
 */

/** Appends `_test` to the database name in a Postgres connection string. */
export function deriveTestDatabaseUrl(url: string): string {
  const parsed = new URL(url)
  // pathname is `/statesman`; a URL with no database name at all is not
  // something the app itself would accept, so it is not special-cased.
  const name = parsed.pathname.replace(/^\//, '')
  if (name === '') {
    throw new Error(`DATABASE_URL has no database name to derive a test one from: ${url}`)
  }
  parsed.pathname = `/${name}_test`
  return parsed.toString()
}

/**
 * Resolves the database the suites run against, and refuses to hand back the
 * development one. The explicit override exists so CI can point at a database
 * it provisioned; the equality check is what makes the mistake unavailable
 * rather than merely discouraged.
 */
export function resolveTestDatabaseUrl(
  source: Readonly<Record<string, string | undefined>>
): string {
  const dev = source.DATABASE_URL
  if (dev === undefined || dev === '') {
    throw new Error('DATABASE_URL is required to run the test suites')
  }
  const test =
    source.TEST_DATABASE_URL !== undefined && source.TEST_DATABASE_URL !== ''
      ? source.TEST_DATABASE_URL
      : deriveTestDatabaseUrl(dev)

  if (test === dev) {
    throw new Error(
      'TEST_DATABASE_URL is the same as DATABASE_URL. The suites truncate what they ' +
        'touch, so pointing them at the development database would delete your own ' +
        'projects, accounts and tokens. Give the test database a different name.'
    )
  }
  return test
}

/** Blob root for the suites, kept off the development one for the same reason. */
export const TEST_STORAGE_PATH = './.data/test-state'
