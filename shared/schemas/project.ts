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

/** `/api/vars/:org/:project/:environment`. The environment slug is a project slug by rule. */
export const environmentRefSchema = projectRefSchema.extend({ environment: projectSlug })

/**
 * Body of `POST /api/ui/projects`. The same `slug` rule the router validates
 * with, deliberately reused rather than restated: a second regex could drift
 * and let the dashboard create a project no backend address could ever resolve.
 *
 * `org` is optional because v1 runs one organization per deployment (spec §5)
 * and the dashboard has nothing else to name it with on an empty project list.
 */
export const createProjectSchema = z.object({
  org: slug.optional(),
  project: slug
})
export type CreateProjectInput = z.infer<typeof createProjectSchema>

const retention = z.number().int().positive().max(100_000).nullable()

/**
 * Body of `PATCH /api/ui/projects/:id`. Strict, so a `slug` field is a 400
 * rather than silently ignored: the slug is in every backend address, token
 * scope and blob key, and is not a setting (project-settings spec §1).
 *
 * A blank description is stored as null, so "cleared" has one representation.
 */
export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    description: z
      .string()
      .max(500)
      .transform((s) => (s.trim() === '' ? null : s.trim()))
      .nullable(),
    retentionKeepVersions: retention,
    retentionKeepDays: retention
  })
  .partial()
  .strict()
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>
