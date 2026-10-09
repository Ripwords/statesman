import { describe, it, expect, beforeAll } from 'vitest'
import { testEvent, isApiError } from '../ui/nitro-globals'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  provisionUser,
  signInHeaders,
  setRole,
  resetDb,
  seedProject,
  grantProjectRole
} from '../protocol/helpers'
import { db } from '../../server/db/client'
import { environment, projectMember, stateVersion } from '../../server/db/schema'
import { NOT_FOUND } from '../../server/utils/project-access'

import listProjects from '../../server/api/ui/projects.get'
import createProject from '../../server/api/ui/projects.post'
import listVersions from '../../server/api/ui/projects/[id]/versions.get'
import readVersion from '../../server/api/ui/versions/[id].get'
import forceUnlock from '../../server/api/ui/projects/[id]/lock.delete'
import listTokens from '../../server/api/ui/tokens.get'
import createToken from '../../server/api/ui/tokens.post'
import deleteToken from '../../server/api/ui/tokens/[id].delete'
import listEnvironments from '../../server/api/ui/projects/[id]/environments.get'
import createEnvironment from '../../server/api/ui/projects/[id]/environments.post'
import deleteEnvironment from '../../server/api/ui/environments/[id].delete'
import listVariables from '../../server/api/ui/environments/[id]/variables.get'
import putVariable from '../../server/api/ui/environments/[id]/variables/[name].put'
import deleteVariable from '../../server/api/ui/environments/[id]/variables/[name].delete'
import importVariables from '../../server/api/ui/environments/[id]/variables/import.post'
import githubInstall from '../../server/api/github/install.get'
import githubSetup from '../../server/api/github/setup.get'
import githubStatus from '../../server/api/ui/github.get'
import listRepos from '../../server/api/ui/github/installations/[id]/repositories.get'
import putLink from '../../server/api/ui/environments/[id]/link.put'
import deleteLink from '../../server/api/ui/environments/[id]/link.delete'
import syncNow from '../../server/api/ui/environments/[id]/sync.post'
import rollback from '../../server/api/admin/rollback.post'
import retention from '../../server/api/admin/retention.post'

type Actor = 'anonymous' | 'stranger' | 'viewer' | 'editor' | 'owner' | 'admin'
type Outcome = 401 | 403 | 404 | 'pass'
type Ids = { projectId: string; envId: string; versionId: string }

const PASSWORD = 'correct horse battery staple'
const ORG = 'route-roles'
const headers = {} as Record<Actor, Record<string, string>>
let ids: Ids

beforeAll(async () => {
  await resetDb(ORG)
  const projectId = await seedProject(ORG, 'p')
  const envId = ulid()
  await db().insert(environment).values({ id: envId, projectId, slug: 'dev' })
  const versionId = ulid()
  await db()
    .insert(stateVersion)
    .values({ id: versionId, projectId, sizeBytes: 0, md5: 'x', blobKey: `missing/${versionId}` })
  ids = { projectId, envId, versionId }
  headers.anonymous = {}
  const stamp = Date.now()
  for (const actor of ['stranger', 'viewer', 'editor', 'owner', 'admin'] as const) {
    const u = await provisionUser(`rr-${actor}-${stamp}@example.com`, PASSWORD)
    await setRole(u.id, actor === 'admin' ? 'admin' : 'member')
    if (actor === 'viewer' || actor === 'editor' || actor === 'owner') {
      await grantProjectRole(projectId, u.id, actor)
    }
    headers[actor] = Object.fromEntries((await signInHeaders(u.email, PASSWORD)).entries())
  }
})

// READ = viewer+ | EDIT = editor+ | OWN = owner+ | ADMIN = deployment admin only
const READ: Record<Actor, Outcome> = {
  anonymous: 401,
  stranger: 404,
  viewer: 'pass',
  editor: 'pass',
  owner: 'pass',
  admin: 'pass'
}
const EDIT: Record<Actor, Outcome> = {
  anonymous: 401,
  stranger: 404,
  viewer: 403,
  editor: 'pass',
  owner: 'pass',
  admin: 'pass'
}
const OWN: Record<Actor, Outcome> = {
  anonymous: 401,
  stranger: 404,
  viewer: 403,
  editor: 403,
  owner: 'pass',
  admin: 'pass'
}
const ADMIN: Record<Actor, Outcome> = {
  anonymous: 401,
  stranger: 403,
  viewer: 403,
  editor: 403,
  owner: 403,
  admin: 'pass'
}
const ANY_SESSION: Record<Actor, Outcome> = {
  anonymous: 401,
  stranger: 'pass',
  viewer: 'pass',
  editor: 'pass',
  owner: 'pass',
  admin: 'pass'
}
const OWNER_SOMEWHERE: Record<Actor, Outcome> = {
  anonymous: 401,
  stranger: 403,
  viewer: 403,
  editor: 403,
  owner: 'pass',
  admin: 'pass'
}
const UNKNOWN_ENV: Record<Actor, Outcome> = {
  anonymous: 401,
  stranger: 404,
  viewer: 404,
  editor: 404,
  owner: 404,
  admin: 404
}

type Call = (h: Record<string, string>, i: Ids) => Promise<unknown>
const ROUTES: Array<[string, Call, Record<Actor, Outcome>]> = [
  ['GET /api/ui/projects', (h) => listProjects(testEvent({ headers: h })), ANY_SESSION],
  [
    'POST /api/ui/projects',
    (h) => createProject(testEvent({ headers: h, body: { project: 'x' } })),
    ADMIN
  ],
  [
    'GET /api/ui/projects/:id/versions',
    (h, i) => listVersions(testEvent({ headers: h, params: { id: i.projectId } })),
    READ
  ],
  [
    'GET /api/ui/versions/:id',
    (h, i) => readVersion(testEvent({ headers: h, params: { id: i.versionId } })),
    READ
  ],
  [
    'DELETE /api/ui/projects/:id/lock',
    (h, i) => forceUnlock(testEvent({ headers: h, params: { id: i.projectId } })),
    EDIT
  ],
  [
    'POST /api/admin/rollback',
    (h, i) =>
      rollback(testEvent({ headers: h, body: { projectId: i.projectId, versionId: 'none' } })),
    OWN
  ],
  [
    'GET /api/ui/projects/:id/environments',
    (h, i) => listEnvironments(testEvent({ headers: h, params: { id: i.projectId } })),
    READ
  ],
  [
    'POST /api/ui/projects/:id/environments',
    (h, i) => createEnvironment(testEvent({ headers: h, params: { id: i.projectId }, body: {} })),
    OWN
  ],
  [
    'DELETE /api/ui/environments/:id',
    (h) => deleteEnvironment(testEvent({ headers: h, params: { id: 'no-such-env' } })),
    UNKNOWN_ENV
  ],
  [
    'GET /api/ui/environments/:id/variables',
    (h, i) => listVariables(testEvent({ headers: h, params: { id: i.envId } })),
    READ
  ],
  [
    'PUT /api/ui/environments/:id/variables/:name',
    (h, i) => putVariable(testEvent({ headers: h, params: { id: i.envId, name: 'x' }, body: {} })),
    EDIT
  ],
  [
    'DELETE /api/ui/environments/:id/variables/:name',
    (h, i) => deleteVariable(testEvent({ headers: h, params: { id: i.envId, name: 'x' } })),
    EDIT
  ],
  [
    'POST /api/ui/environments/:id/variables/import',
    (h, i) => importVariables(testEvent({ headers: h, params: { id: i.envId }, body: {} })),
    EDIT
  ],
  [
    'PUT /api/ui/environments/:id/link',
    (h, i) => putLink(testEvent({ headers: h, params: { id: i.envId }, body: {} })),
    OWN
  ],
  [
    'DELETE /api/ui/environments/:id/link',
    (h, i) => deleteLink(testEvent({ headers: h, params: { id: i.envId } })),
    OWN
  ],
  [
    'POST /api/ui/environments/:id/sync',
    (h, i) => syncNow(testEvent({ headers: h, params: { id: i.envId } })),
    EDIT
  ],
  [
    'GET /api/ui/github/installations/:id/repositories',
    (h) => listRepos(testEvent({ headers: h, params: { id: '1' } })),
    OWNER_SOMEWHERE
  ],
  ['GET /api/github/install', (h) => githubInstall(testEvent({ headers: h })), ADMIN],
  ['GET /api/github/setup', (h) => githubSetup(testEvent({ headers: h })), ADMIN],
  ['GET /api/ui/github', (h) => githubStatus(testEvent({ headers: h })), ANY_SESSION],
  ['POST /api/admin/retention', (h) => retention(testEvent({ headers: h })), ADMIN],
  // Token routes stay admin-only until the token task moves them to project owners.
  ['GET /api/ui/tokens', (h) => listTokens(testEvent({ headers: h })), ADMIN],
  ['POST /api/ui/tokens', (h) => createToken(testEvent({ headers: h, body: {} })), ADMIN],
  [
    'DELETE /api/ui/tokens/:id',
    (h) => deleteToken(testEvent({ headers: h, params: { id: 'k1' } })),
    ADMIN
  ]
]

describe.each(ROUTES)('%s', (_name, call, expected) => {
  it.each(Object.entries(expected) as Array<[Actor, Outcome]>)(
    '%s -> %s',
    async (actor, outcome) => {
      expect(await outcomeOf(call(headers[actor], ids))).toBe(outcome)
    }
  )
})

describe('non-member 404', () => {
  it('is byte-identical to an unknown project id', async () => {
    const stranger = await errorOf(
      listVersions(testEvent({ headers: headers.stranger, params: { id: ids.projectId } }))
    )
    const unknown = await errorOf(
      listVersions(testEvent({ headers: headers.viewer, params: { id: 'nope' } }))
    )
    expect(stranger).toEqual({ statusCode: 404, statusMessage: NOT_FOUND })
    expect(unknown).toEqual(stranger)
  })
})

describe('cross-project ids', () => {
  it('a viewer of project A gets 404 for an environment in project B', async () => {
    const other = await seedProject(ORG, 'other')
    const otherEnv = ulid()
    await db().insert(environment).values({ id: otherEnv, projectId: other, slug: 'dev' })
    expect(
      await outcomeOf(
        listVariables(testEvent({ headers: headers.viewer, params: { id: otherEnv } }))
      )
    ).toBe(404)
  })
})

describe('removed member', () => {
  it('gets 404 on every project route after removal', async () => {
    const stamp = Date.now()
    const u = await provisionUser(`rr-removed-${stamp}@example.com`, PASSWORD)
    await setRole(u.id, 'member')
    await grantProjectRole(ids.projectId, u.id, 'viewer')
    const h = Object.fromEntries((await signInHeaders(u.email, PASSWORD)).entries())
    await db().delete(projectMember).where(eq(projectMember.userId, u.id))
    for (const [, call, expected] of ROUTES) {
      if (expected.stranger !== 404) continue
      expect(await outcomeOf(call(h, ids))).toBe(404)
    }
  })
})

/**
 * 404 means the guard's NOT_FOUND specifically. A route's own 404 (a missing
 * blob, an unknown version) is the route running, which counts as 'pass'.
 */
async function outcomeOf(call: Promise<unknown>): Promise<Outcome> {
  try {
    await call
    return 'pass'
  } catch (error) {
    if (!isApiError(error)) return 'pass'
    if (error.statusCode === 401 || error.statusCode === 403) return error.statusCode
    if (error.statusCode === 404 && error.statusMessage === NOT_FOUND) return 404
    return 'pass'
  }
}

async function errorOf(
  call: Promise<unknown>
): Promise<{ statusCode?: number; statusMessage?: string }> {
  try {
    await call
    return {}
  } catch (error) {
    return isApiError(error)
      ? { statusCode: error.statusCode, statusMessage: error.statusMessage }
      : {}
  }
}
