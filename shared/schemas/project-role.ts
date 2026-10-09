import { z } from 'zod'

/**
 * A role on ONE project. Deployment-wide authority is `user.role`
 * (shared/schemas/user.ts); this is the second and last level.
 */
export const projectRoleSchema = z.enum(['viewer', 'editor', 'owner'])
export type ProjectRole = z.infer<typeof projectRoleSchema>

/** Body of `POST /api/ui/projects/:id/members`. */
export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: projectRoleSchema
})
export type AddMemberInput = z.infer<typeof addMemberSchema>

/** Body of `PATCH /api/ui/projects/:id/members/:userId`. */
export const changeMemberRoleSchema = z.object({ role: projectRoleSchema })
