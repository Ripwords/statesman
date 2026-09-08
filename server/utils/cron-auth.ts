import { createHash, timingSafeEqual } from 'node:crypto'

export type CronAuthOutcome = 'ok' | 'denied' | 'not-configured'

/**
 * Whether a request carries the scheduler's shared secret.
 *
 * Pure and separate from the route so every branch is testable without an
 * H3Event, and because "did this request prove it is the cron" is the only
 * question worth getting exactly right here.
 *
 * `not-configured` is distinct from `denied` on purpose. A deployment with no
 * CRON_SECRET has no scheduler door at all, and the route answers 404: an
 * unset secret must never quietly become an endpoint anyone can call, which is
 * what a bare `header === undefined` check would have produced if the secret
 * were also undefined.
 */
export function cronAuthOutcome(input: {
  secret: string | undefined
  authorization: string | undefined
}): CronAuthOutcome {
  if (input.secret === undefined || input.secret === '') return 'not-configured'

  const header = input.authorization
  if (header === undefined) return 'denied'

  // RFC 7235: the scheme is case-insensitive. Vercel sends "Bearer".
  const match = /^bearer +(.*)$/i.exec(header)
  const presented = match?.[1]
  if (presented === undefined || presented === '') return 'denied'

  return equalsInConstantTime(presented, input.secret) ? 'ok' : 'denied'
}

/**
 * Compares by digest rather than by bytes.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, so calling it
 * on the raw values would need a length check first — and that check leaks the
 * secret's length through timing before the comparison even starts. Hashing
 * both sides first makes every comparison the same fixed 32 bytes.
 */
function equalsInConstantTime(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(a), digest(b))
}
