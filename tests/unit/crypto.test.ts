import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { seal, open } from '../../server/utils/crypto'

const key = randomBytes(32)

describe('crypto', () => {
  it('round-trips a payload', () => {
    const plain = Buffer.from(JSON.stringify({ version: 4, serial: 1 }))
    expect(open(key, seal(key, plain))).toEqual(plain)
  })

  it('produces different ciphertext for identical input', () => {
    const plain = Buffer.from('same')
    expect(seal(key, plain).equals(seal(key, plain))).toBe(false)
  })

  it('rejects a tampered payload', () => {
    const sealed = seal(key, Buffer.from('secret'))
    const last = sealed.length - 1
    sealed.writeUInt8(sealed.readUInt8(last) ^ 0xff, last)
    expect(() => open(key, sealed)).toThrow()
  })

  it('rejects the wrong key', () => {
    const sealed = seal(key, Buffer.from('secret'))
    expect(() => open(randomBytes(32), sealed)).toThrow()
  })

  it('handles an empty payload', () => {
    expect(open(key, seal(key, Buffer.alloc(0)))).toHaveLength(0)
  })
})
