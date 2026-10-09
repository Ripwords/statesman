import { describe, it, expect } from 'vitest'
import { MIN_ROLE, roleAllows, type ProjectPermission } from '../../shared/project-permissions'
import { minimumRoleFor, projectCan } from '../../server/utils/project-access'

const ALL = Object.keys(MIN_ROLE) as ProjectPermission[]

describe('UI permission table', () => {
  it.each(ALL)('%s agrees with the server role objects', (permission) => {
    expect(MIN_ROLE[permission]).toBe(minimumRoleFor(permission))
    for (const role of ['viewer', 'editor', 'owner', 'admin'] as const) {
      expect(roleAllows(role, permission)).toBe(projectCan(role, permission))
    }
  })

  it('allows nothing without a role', () => {
    expect(ALL.some((p) => roleAllows(null, p))).toBe(false)
  })
})
