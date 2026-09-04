/**
 * Same-origin paths only, so a crafted `?redirect=` cannot bounce anyone
 * off-site. `//evil.example` is protocol-relative and would do exactly that,
 * which is why a leading-slash test alone is not enough.
 *
 * Shared rather than inlined at each call site: the guard is used by both the
 * route middleware and the sign-in page, and a security check that exists twice
 * is a security check that drifts.
 */
export function safeInternalPath(value: unknown, fallback = '/'): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : fallback
}
