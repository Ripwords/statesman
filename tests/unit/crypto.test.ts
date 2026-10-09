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

// Sealed by the code as it stood before AAD existed. Every state blob in every
// deployment has this shape; opening it without AAD must keep working forever.
const GOLDEN =
  '2eaa2ef4ae484f33c3a34963dfea675ad091927825f8517c176c92e15de952dbf77710a9a2d4e44eb7de648c'

describe('crypto with associated data', () => {
  const aad = Buffer.from('variable:env1:db_password')

  it('round-trips with matching aad', () => {
    const plain = Buffer.from('"hunter2"')
    expect(open(key, seal(key, plain, aad), aad)).toEqual(plain)
  })

  it('rejects a different aad', () => {
    const sealed = seal(key, Buffer.from('"hunter2"'), aad)
    expect(() => open(key, sealed, Buffer.from('variable:env2:db_password'))).toThrow()
  })

  it('rejects aad-sealed data opened without aad', () => {
    const sealed = seal(key, Buffer.from('"hunter2"'), aad)
    expect(() => open(key, sealed)).toThrow()
  })

  it('still opens pre-aad ciphertext without aad', () => {
    const opened = open(Buffer.alloc(32, 7), Buffer.from(GOLDEN, 'hex'))
    expect(opened.toString('utf8')).toBe('statesman golden')
  })
})
