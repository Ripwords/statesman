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

describe('S3_FORCE_PATH_STYLE', () => {
  it('reads "false" as false', () => {
    expect(loadEnv({ ...base, S3_FORCE_PATH_STYLE: 'false' } as NodeJS.ProcessEnv).S3_FORCE_PATH_STYLE)
      .toBe(false)
  })

  it('reads "0" as false', () => {
    expect(loadEnv({ ...base, S3_FORCE_PATH_STYLE: '0' } as NodeJS.ProcessEnv).S3_FORCE_PATH_STYLE)
      .toBe(false)
  })

  it('reads "true" as true', () => {
    expect(loadEnv({ ...base, S3_FORCE_PATH_STYLE: 'true' } as NodeJS.ProcessEnv).S3_FORCE_PATH_STYLE)
      .toBe(true)
  })

  it('treats an empty value as unset and uses the default', () => {
    expect(loadEnv({ ...base, S3_FORCE_PATH_STYLE: '' } as NodeJS.ProcessEnv).S3_FORCE_PATH_STYLE)
      .toBe(false)
  })

  it('rejects a value that is not a boolean', () => {
    expect(() => loadEnv({ ...base, S3_FORCE_PATH_STYLE: 'maybe' } as NodeJS.ProcessEnv))
      .toThrow(/S3_FORCE_PATH_STYLE/)
  })
})

describe('serverless detection', () => {
  it('detects a lambda even when VERCEL is present but empty', () => {
    const bad = {
      ...base,
      STORAGE_DRIVER: 'local',
      VERCEL: '',
      AWS_LAMBDA_FUNCTION_NAME: 'my-fn'
    }
    expect(() => loadEnv(bad as NodeJS.ProcessEnv)).toThrow(/ephemeral/i)
  })

  it('reports IS_SERVERLESS when only a lambda name is set', () => {
    const env = loadEnv({
      ...base,
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'b',
      VERCEL: '',
      AWS_LAMBDA_FUNCTION_NAME: 'my-fn'
    } as NodeJS.ProcessEnv)
    expect(env.IS_SERVERLESS).toBe(true)
  })

  it('is not serverless on a plain node host', () => {
    expect(loadEnv({ ...base } as NodeJS.ProcessEnv).IS_SERVERLESS).toBe(false)
  })
})
