import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * GitHub signs the exact bytes it sent. This must run on the raw body before
 * anything parses it: re-serialised JSON is not the same bytes.
 */
export function verifySignature(
  secret: string,
  rawBody: Uint8Array,
  header: string | undefined
): boolean {
  if (!header?.startsWith('sha256=')) return false
  const given = Buffer.from(header.slice(7), 'hex')
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  // A non-hex header decodes short; timingSafeEqual throws on unequal lengths.
  return given.length === expected.length && timingSafeEqual(given, expected)
}
