import { z } from 'zod'

export const stateActionSchema = z.enum(['read', 'write', 'delete', 'lock'])
export type StateAction = z.infer<typeof stateActionSchema>

export const tokenScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({
    kind: z.literal('projects'),
    projects: z.array(z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/)).min(1)
  })
])
export type TokenScope = z.infer<typeof tokenScopeSchema>

export const tokenConfigSchema = z.object({
  name: z.string().min(1).max(64),
  actions: z.array(stateActionSchema).min(1),
  scope: tokenScopeSchema,
  expiresInDays: z.number().int().positive().max(3650).optional(),
  rateLimitMax: z.number().int().positive().optional(),
  rateLimitWindowSeconds: z.number().int().positive().optional()
})
export type TokenConfig = z.infer<typeof tokenConfigSchema>
