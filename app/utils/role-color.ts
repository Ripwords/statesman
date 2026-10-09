import type { EffectiveRole } from '~~/shared/project-permissions'

/** Badge colour for a role, shared by the list, the project page and the members table. */
export const ROLE_COLOR = {
  admin: 'primary',
  owner: 'success',
  editor: 'info',
  viewer: 'neutral'
} as const satisfies Record<EffectiveRole, string>
