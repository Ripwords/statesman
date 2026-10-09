import { describe, it, expect } from 'vitest'
import {
  projectCan,
  minimumRoleFor,
  type ProjectPermission
} from '../../server/utils/project-access'

// Spec §3, row by row.
const TABLE: Array<[ProjectPermission, boolean, boolean, boolean]> = [
  //                          viewer editor owner
  ['project:read', true, true, true],
  ['project:unlock', false, true, true],
  ['environment:sync', false, true, true],
  ['variable:write', false, true, true],
  ['environment:create', false, false, true],
  ['environment:delete', false, false, true],
  ['environment:link', false, false, true],
  ['project:rollback', false, false, true],
  ['member:manage', false, false, true],
  ['token:create', false, false, true]
]

describe.each(TABLE)('%s', (permission, viewer, editor, owner) => {
  it('matches spec §3 for each project role', () => {
    expect(projectCan('viewer', permission)).toBe(viewer)
    expect(projectCan('editor', permission)).toBe(editor)
    expect(projectCan('owner', permission)).toBe(owner)
  })

  it('is always allowed for a deployment admin', () => {
    expect(projectCan('admin', permission)).toBe(true)
  })

  it('names the lowest role that may do it, for the 403 message', () => {
    expect(minimumRoleFor(permission)).toBe(viewer ? 'viewer' : editor ? 'editor' : 'owner')
  })
})
