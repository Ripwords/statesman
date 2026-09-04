import { describe, it, expect } from 'vitest'
import { redactForHealth } from '../../server/utils/health'

// /api/health is unauthenticated, so these are the shapes that must never
// survive into a response body. They are constructed directly rather than
// provoked through the real drivers: the point is that a future version of
// drizzle or the AWS SDK might start putting these in .message, and this must
// hold when it does.
describe('redactForHealth', () => {
  it('strips a database connection string', () => {
    const detail = redactForHealth(
      new Error('connect ECONNREFUSED postgres://statesman:hunter2@db.internal:5432/statesman')
    )
    expect(detail).not.toContain('hunter2')
    expect(detail).not.toContain('db.internal')
    expect(detail).toContain('<redacted-url>')
  })

  it('strips an s3 endpoint', () => {
    const detail = redactForHealth(new Error('failed to reach https://minio.internal:9000/bucket'))
    expect(detail).not.toContain('minio.internal')
    expect(detail).not.toContain('bucket')
  })

  it('strips an absolute filesystem path', () => {
    const detail = redactForHealth(
      new Error("ENOTDIR: not a directory, mkdir '/Users/someone/secrets/state/probe'")
    )
    expect(detail).not.toContain('/Users/someone')
    expect(detail).not.toContain('secrets')
    expect(detail).toContain('<redacted-path>')
  })

  it('strips a bare host:port, which is node’s own ECONNREFUSED format', () => {
    const detail = redactForHealth(new Error('connect ECONNREFUSED 10.0.0.5:5432'))
    expect(detail).not.toContain('10.0.0.5')
    expect(detail).not.toContain('5432')
    expect(detail).toContain('<redacted-host>')
  })

  it('strips a bare ipv4 with no port', () => {
    expect(redactForHealth(new Error('no route to host 192.168.10.20'))).not.toContain(
      '192.168.10.20'
    )
  })

  it('strips a bracketed ipv6 host:port', () => {
    const detail = redactForHealth(
      new Error('connect ECONNREFUSED [fe80::a00:27ff:fe4e:66a1]:5432')
    )
    expect(detail).not.toContain('fe80')
    expect(detail).not.toContain('27ff')
  })

  it('strips an unbracketed ipv6 host:port', () => {
    const detail = redactForHealth(new Error('connect ECONNREFUSED ::1:5432'))
    expect(detail).not.toContain('::1:5432')
  })

  it('strips an aws arn', () => {
    const detail = redactForHealth(
      new Error('AccessDenied: arn:aws:iam::123456789012:role/statesman-prod is not authorized')
    )
    expect(detail).not.toContain('123456789012')
    expect(detail).not.toContain('statesman-prod')
    expect(detail).toContain('<redacted-arn>')
  })

  it('leaves an ordinary query error legible', () => {
    // Over-redaction costs debuggability, so the common case must survive.
    expect(redactForHealth(new Error('Failed query: select 1'))).toBe('Failed query: select 1')
  })

  it('does not mangle a postgres cast or a timestamp', () => {
    expect(redactForHealth(new Error('Failed query: select 1::text at 11:42:15'))).toBe(
      'Failed query: select 1::text at 11:42:15'
    )
  })

  it('keeps only the first line and caps the length', () => {
    const detail = redactForHealth(new Error(`first line\nsecond line with detail`))
    expect(detail).toBe('first line')
    expect(redactForHealth(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(120)
  })

  it('redacts before truncating, so a long url cannot survive as a fragment', () => {
    const detail = redactForHealth(
      new Error(`${'padding '.repeat(12)}postgres://user:hunter2@host:5432/db`)
    )
    expect(detail).not.toContain('hunter2')
  })

  it('redacts a unc path without leaving a leading separator', () => {
    expect(redactForHealth(new Error('cannot open \\\\fileserver\\share\\state'))).toBe(
      'cannot open <redacted-path>'
    )
  })

  it('handles a non-Error throwable', () => {
    expect(redactForHealth('plain string failure')).toBe('plain string failure')
  })
})
