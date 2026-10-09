import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySignature } from '../../server/github/signature'

const body = Buffer.from('{"zen":"Keep it logically awesome."}')
const sign = (secret: string, b: Uint8Array) =>
  `sha256=${createHmac('sha256', secret).update(b).digest('hex')}`

describe('verifySignature', () => {
  it('accepts a correct signature', () => {
    expect(verifySignature('s', body, sign('s', body))).toBe(true)
  })
  it('refuses the wrong secret', () => {
    expect(verifySignature('s', body, sign('t', body))).toBe(false)
  })
  it('refuses a missing header', () => {
    expect(verifySignature('s', body, undefined)).toBe(false)
  })
  it('refuses a body changed by one byte', () => {
    const altered = Buffer.from(body)
    altered[0] = (altered[0] ?? 0) ^ 1
    expect(verifySignature('s', altered, sign('s', body))).toBe(false)
  })
  it('refuses a malformed header without throwing', () => {
    expect(verifySignature('s', body, 'sha256=zz')).toBe(false)
    expect(verifySignature('s', body, 'sha1=abc')).toBe(false)
  })
})
