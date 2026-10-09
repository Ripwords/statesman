/**
 * The server's own `statusMessage` names the actual problem (a duplicate slug,
 * a malformed name), so it is shown verbatim. Anything without one (a dropped
 * connection, a thrown string) gets the caller's fallback. Duck-typed rather
 * than `instanceof FetchError` because `useFetch` surfaces a NuxtError, which
 * carries the same field.
 */
export function statusMessageOf(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'statusMessage' in error) {
    const message = error.statusMessage
    if (typeof message === 'string' && message !== '') return message
  }
  return fallback
}
