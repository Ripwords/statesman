import { z } from 'zod'

// The regex is also the path-traversal guard: no dots, no slashes, so an org
// or project slug can never escape a blob key prefix.
const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase letters, digits and dashes')

export const projectRefSchema = z.object({ org: slug, project: slug })
export type ProjectRef = z.infer<typeof projectRefSchema>

export const projectSlug = slug
