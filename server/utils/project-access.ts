import { createAccessControl } from 'better-auth/plugins/access'

/**
 * What a project role may do, in the organization plugin's vocabulary.
 * Spec §3 is the table; this is its only encoding. No route compares role
 * strings — they ask `projectCan`, which asks these objects.
 */
export const projectStatements = {
  project: ['read', 'rollback', 'unlock'],
  environment: ['create', 'delete', 'link', 'sync'],
  variable: ['write'],
  member: ['manage'],
  token: ['create']
} as const

export const projectAc = createAccessControl(projectStatements)

export const projectRoles = {
  viewer: projectAc.newRole({ project: ['read'] }),
  editor: projectAc.newRole({
    project: ['read', 'unlock'],
    environment: ['sync'],
    variable: ['write']
  }),
  owner: projectAc.newRole({
    project: ['read', 'rollback', 'unlock'],
    environment: ['create', 'delete', 'link', 'sync'],
    variable: ['write'],
    member: ['manage'],
    token: ['create']
  })
}
