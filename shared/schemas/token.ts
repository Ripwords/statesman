import { z } from 'zod'
import { projectSlug } from './project'

/** `<org>/<project>`, with both halves held to the router's own slug rule. */
function isProjectRef(value: string): boolean {
  const [org, project, ...rest] = value.split('/')
  if (rest.length > 0) return false
  return projectSlug.safeParse(org).success && projectSlug.safeParse(project).success
}

export const stateActionSchema = z.enum(['read', 'write', 'delete', 'lock'])
export type StateAction = z.infer<typeof stateActionSchema>

export const tokenScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({
    kind: z.literal('projects'),
    // Checked with the same slug rule the router resolves with, rather than a
    // third regex. The copy this replaces had already drifted: it accepted a
    // leading dash, which projectSlug rejects, so a scope could name a project
    // no address could ever reach. The type stays string[] on purpose — a
    // template-literal type here would ripple into every form that builds one.
    projects: z.array(z.string().refine(isProjectRef, 'must be "<org>/<project>"')).min(1)
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
