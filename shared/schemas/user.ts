import { z } from 'zod'

/**
 * The two roles this deployment has.
 *
 * `member` rather than better-auth's own default name `user`, because `user` is
 * also the table name and reads as "any account" in exactly the sentences where
 * the distinction matters. The name is configured on the admin plugin, so the
 * plugin never writes `user` into the column.
 *
 * Both roles still read every project's decrypted state. The split is about who
 * may CHANGE things — accounts, roles, tokens, locks, history — not about who
 * may see them. Per-project isolation is a different feature and is not this one.
 */
export const userRoleSchema = z.enum(['admin', 'member'])
export type UserRole = z.infer<typeof userRoleSchema>

/** The role a row without a usable one falls back to. */
export const DEFAULT_ROLE: UserRole = 'member'

/**
 * Narrows the nullable, free-text `user.role` column to a role.
 *
 * The column is `text` and nullable — the admin plugin declares it
 * `required: false`, and rows written before the column existed hold NULL — so
 * the value arriving here is genuinely `string | null | undefined`. Everything
 * unrecognised resolves to the LEAST privilege, because the opposite default
 * turns a typo in the database into an administrator.
 */
export function roleOf(value: string | null | undefined): UserRole {
  const parsed = userRoleSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_ROLE
}

export function isAdmin(value: string | null | undefined): boolean {
  return roleOf(value) === 'admin'
}

/** Body of `PATCH /api/ui/users/:id/role`. */
export const changeRoleSchema = z.object({ role: userRoleSchema })
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>
