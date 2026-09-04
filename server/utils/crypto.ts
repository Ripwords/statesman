import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Wire format: [12-byte IV][16-byte GCM tag][ciphertext].
 *
 * A fresh random IV per call is what makes two seals of identical plaintext
 * produce different bytes. Never reuse an IV with the same key.
 */
export function seal(key: Buffer, plaintext: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

/**
 * Throws if the payload was tampered with or the key is wrong — a corrupt
 * blob must fail loudly rather than return plausible-looking garbage.
 */
export function open(key: Buffer, sealed: Uint8Array): Buffer {
  const buf = Buffer.from(sealed)
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error('ciphertext too short to be valid')
  }
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}
