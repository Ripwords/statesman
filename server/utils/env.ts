import { z } from 'zod'

const encryptionKey = z
  .string({ error: 'STATESMAN_ENCRYPTION_KEY is required — run `pnpm gen:key`' })
  .transform((raw, ctx) => {
    let buf: Buffer
    try {
      buf = Buffer.from(raw, 'base64')
    } catch {
      ctx.addIssue({ code: 'custom', message: 'STATESMAN_ENCRYPTION_KEY must be base64' })
      return z.NEVER
    }
    if (buf.length !== 32) {
      ctx.addIssue({
        code: 'custom',
        message: `STATESMAN_ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}`
      })
      return z.NEVER
    }
    return buf
  })

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    DB_DRIVER: z.enum(['neon', 'node']).default('node'),
    STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
    STATESMAN_ENCRYPTION_KEY: encryptionKey,
    LOCAL_STORAGE_PATH: z.string().default('./.data/state'),
    S3_BUCKET: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().min(1),
    RETENTION_KEEP_VERSIONS: z.coerce.number().int().positive().default(100),
    RETENTION_KEEP_DAYS: z.coerce.number().int().positive().default(30),
    VERCEL: z.string().optional(),
    AWS_LAMBDA_FUNCTION_NAME: z.string().optional()
  })
  .superRefine((v, ctx) => {
    const serverless = Boolean(v.VERCEL ?? v.AWS_LAMBDA_FUNCTION_NAME)
    if (v.STORAGE_DRIVER === 'local' && serverless) {
      ctx.addIssue({
        code: 'custom',
        message:
          'STORAGE_DRIVER=local cannot run on a serverless platform: the filesystem is ephemeral and state would be lost on the next cold start. Use STORAGE_DRIVER=s3.'
      })
    }
    if (v.STORAGE_DRIVER === 's3' && !v.S3_BUCKET) {
      ctx.addIssue({ code: 'custom', message: 'S3_BUCKET is required when STORAGE_DRIVER=s3' })
    }
  })

export type Env = {
  DATABASE_URL: string
  DB_DRIVER: 'neon' | 'node'
  STORAGE_DRIVER: 's3' | 'local'
  ENCRYPTION_KEY: Buffer
  LOCAL_STORAGE_PATH: string
  S3_BUCKET?: string
  S3_ENDPOINT?: string
  S3_REGION: string
  S3_FORCE_PATH_STYLE: boolean
  S3_ACCESS_KEY_ID?: string
  S3_SECRET_ACCESS_KEY?: string
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL: string
  RETENTION_KEEP_VERSIONS: number
  RETENTION_KEEP_DAYS: number
  IS_SERVERLESS: boolean
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid statesman configuration:\n${detail}`)
  }
  const v = parsed.data
  return {
    DATABASE_URL: v.DATABASE_URL,
    DB_DRIVER: v.DB_DRIVER,
    STORAGE_DRIVER: v.STORAGE_DRIVER,
    ENCRYPTION_KEY: v.STATESMAN_ENCRYPTION_KEY,
    LOCAL_STORAGE_PATH: v.LOCAL_STORAGE_PATH,
    S3_BUCKET: v.S3_BUCKET,
    S3_ENDPOINT: v.S3_ENDPOINT,
    S3_REGION: v.S3_REGION,
    S3_FORCE_PATH_STYLE: v.S3_FORCE_PATH_STYLE,
    S3_ACCESS_KEY_ID: v.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: v.S3_SECRET_ACCESS_KEY,
    BETTER_AUTH_SECRET: v.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: v.BETTER_AUTH_URL,
    RETENTION_KEEP_VERSIONS: v.RETENTION_KEEP_VERSIONS,
    RETENTION_KEEP_DAYS: v.RETENTION_KEEP_DAYS,
    IS_SERVERLESS: Boolean(v.VERCEL ?? v.AWS_LAMBDA_FUNCTION_NAME)
  }
}

let cached: Env | undefined
export function env(): Env {
  cached ??= loadEnv()
  return cached
}
