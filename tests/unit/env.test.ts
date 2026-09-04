import { describe, it, expect } from 'vitest'
import { loadEnv } from '../../server/utils/env'

const KEY = Buffer.alloc(32, 7).toString('base64')

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/statesman',
  STATESMAN_ENCRYPTION_KEY: KEY,
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000'
}

describe('loadEnv', () => {
  it('parses a minimal valid environment', () => {
    const env = loadEnv({ ...base } as NodeJS.ProcessEnv)
    expect(env.DB_DRIVER).toBe('node')
    expect(env.STORAGE_DRIVER).toBe('local')
    expect(env.ENCRYPTION_KEY).toHaveLength(32)
  })

  it('refuses to start without an encryption key', () => {
    const { STATESMAN_ENCRYPTION_KEY, ...withoutKey } = base
    expect(() => loadEnv(withoutKey as NodeJS.ProcessEnv))
      .toThrow(/STATESMAN_ENCRYPTION_KEY/)
  })

  it('rejects an encryption key that is not 32 bytes', () => {
    const short = { ...base, STATESMAN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }
    expect(() => loadEnv(short as NodeJS.ProcessEnv)).toThrow(/32 bytes/)
  })

  it('rejects local storage on a serverless platform', () => {
    const bad = { ...base, STORAGE_DRIVER: 'local', VERCEL: '1' }
    expect(() => loadEnv(bad as NodeJS.ProcessEnv))
      .toThrow(/ephemeral/i)
  })

  it('requires a bucket when the s3 driver is selected', () => {
    const bad = { ...base, STORAGE_DRIVER: 's3' }
    expect(() => loadEnv(bad as NodeJS.ProcessEnv)).toThrow(/S3_BUCKET/)
  })
})
