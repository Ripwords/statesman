import { z } from 'zod'
import type { JsonValue } from './variable'

export const MAX_BACKEND_KEYS = 32

const CREDENTIAL_KEYS = new Set([
  'access_key',
  'secret_key',
  'token',
  'password',
  'credentials', // gcs: service account JSON
  'encryption_key', // gcs
  'sse_customer_key', // s3
  'client_key', // kubernetes
  'conn_str', // pg: the connection string embeds the password
  'http_auth', // consul: user:pass
  'secret_id' // cos
])
// `key` (the s3 state key), `kms_key_id` and `workspace_key_prefix` do not end in `_key`.
const CREDENTIAL_SUFFIXES = ['_secret', '_token', '_password', '_key']

/**
 * Backend settings are stored and shown in plaintext (checkout spec §3), so a
 * key that names a credential is refused rather than encrypted.
 */
export function isCredentialKey(key: string): boolean {
  const k = key.toLowerCase()
  return CREDENTIAL_KEYS.has(k) || CREDENTIAL_SUFFIXES.some((s) => k.endsWith(s))
}

// Checked in the superRefine below: a regex key schema on z.record only reports
// the generic "Invalid key in record", losing this message.
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/
const KEY_MESSAGE =
  'Backend setting names use lowercase letters, digits and underscores, and start with a letter.'

const valueSchema = z.union([z.string().max(2048), z.number(), z.boolean()])

export const backendSettingsSchema = z.record(z.string(), valueSchema).superRefine((map, ctx) => {
  const keys = Object.keys(map)
  if (keys.length > MAX_BACKEND_KEYS) {
    ctx.addIssue({ code: 'custom', message: `At most ${MAX_BACKEND_KEYS} backend settings.` })
  }
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) {
      ctx.addIssue({ code: 'custom', path: [key], message: KEY_MESSAGE })
    } else if (isCredentialKey(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message:
          `${key} looks like a credential. Backend settings are stored unencrypted, so ` +
          `use the provider's credential chain, or TF_HTTP_PASSWORD for statesman's own backend.`
      })
    }
  }
})

export type BackendSettings = Record<string, string | number | boolean>

export const putBackendSchema = z.union([
  z.object({ backend: backendSettingsSchema.nullable() }).strict(),
  z.object({ hcl: z.string().max(65_536) }).strict()
])
export type PutBackendInput = z.infer<typeof putBackendSchema>

export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid backend settings'
  // A refused key reports through its path; the message already names it.
  // A value of the wrong type is a failed union with only a generic message.
  const key = issue.path.at(-1)
  if (issue.code === 'invalid_union' && typeof key === 'string') {
    return `${key} must be a string, number or boolean`
  }
  return issue.message
}

/** Body of GET /api/checkout/:org/:project/:environment (checkout spec §4). */
export type CheckoutResponse = {
  variables: Record<string, JsonValue>
  backend: BackendSettings | null
}
