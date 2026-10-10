import type { ProjectRole } from './schemas/project-role'

export type ProjectPermission =
  | 'project:read'
  | 'project:update'
  | 'project:rollback'
  | 'project:unlock'
  | 'environment:create'
  | 'environment:delete'
  | 'environment:link'
  | 'environment:sync'
  | 'variable:write'
  | 'variable:download'
  | 'member:manage'
  | 'token:create'

export type EffectiveRole = ProjectRole | 'admin'

/** For the UI's show/hide only. The server's role objects are the authority. */
export const MIN_ROLE: Record<ProjectPermission, ProjectRole> = {
  'project:read': 'viewer',
  'project:unlock': 'editor',
  'environment:sync': 'editor',
  'variable:write': 'editor',
  'project:update': 'owner',
  'project:rollback': 'owner',
  'environment:create': 'owner',
  'environment:delete': 'owner',
  'environment:link': 'owner',
  'variable:download': 'owner',
  'member:manage': 'owner',
  'token:create': 'owner'
}

const RANK: Record<EffectiveRole, number> = { viewer: 0, editor: 1, owner: 2, admin: 3 }

export function roleAllows(
  role: EffectiveRole | null | undefined,
  permission: ProjectPermission
): boolean {
  return role != null && RANK[role] >= RANK[MIN_ROLE[permission]]
}
