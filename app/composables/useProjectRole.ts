import {
  roleAllows,
  type EffectiveRole,
  type ProjectPermission
} from '~~/shared/project-permissions'

/**
 * Show/hide for a project role. Presentation only: every route behind a control
 * checks server-side, and this is the same table the server's role objects
 * encode (see tests/unit/project-role-ui.test.ts).
 */
export function useProjectRole(role: Ref<EffectiveRole | null | undefined>) {
  return { can: (permission: ProjectPermission) => roleAllows(role.value, permission) }
}
