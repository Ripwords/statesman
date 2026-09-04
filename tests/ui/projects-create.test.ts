// First, and deliberately: projects.post calls defineEventHandler at module
// evaluation, which is a Nitro auto-import this file has to stand up before the
// handler is imported. See the note in ./nitro-globals.
import { testEvent, isApiError } from './nitro-globals'
import { describe, expect, it } from 'vitest'
import createHandler from '../../server/api/ui/projects.post'
import { chooseOrganization } from '../../server/utils/organization'
import { createProjectSchema } from '../../shared/schemas/project'

const acme = { id: 'org-1', slug: 'acme' }
const widgets = { id: 'org-2', slug: 'widgets' }

/** The thrown value is an h3 error; this reads its status without a cast. */
function statusOf(run: () => unknown): number {
  try {
    run()
  } catch (error) {
    if (isApiError(error)) return error.statusCode
    throw error
  }
  throw new Error('expected chooseOrganization to throw')
}

describe('chooseOrganization', () => {
  it('returns the named organization', () => {
    expect(chooseOrganization('widgets', [acme, widgets])).toEqual(widgets)
  })

  it('answers 404 for a named organization that does not exist', () => {
    expect(statusOf(() => chooseOrganization('nope', [acme]))).toBe(404)
  })

  it('resolves the single organization when the body omits one', () => {
    // The case the dashboard depends on: an empty project list gives the form
    // nothing to name an organization with.
    expect(chooseOrganization(undefined, [acme])).toEqual(acme)
  })

  it('answers 404 when nothing has been seeded yet', () => {
    expect(statusOf(() => chooseOrganization(undefined, []))).toBe(404)
  })

  it('asks rather than guesses when several exist', () => {
    // Unreachable in a supported v1 deployment, but guessing would silently
    // decide which :org segment every future backend address carries.
    expect(statusOf(() => chooseOrganization(undefined, [acme, widgets]))).toBe(400)
  })
})

describe('project create schema', () => {
  it('accepts a slug the terraform router can resolve', () => {
    expect(createProjectSchema.parse({ project: 'my-app-prod' })).toEqual({
      project: 'my-app-prod'
    })
  })

  it.each(['Uppercase', 'has/slash', '..', '-leading', 'trailing ', '', 'a'.repeat(65)])(
    'rejects %j',
    (project) => {
      expect(createProjectSchema.safeParse({ project }).success).toBe(false)
    }
  )
})

describe('POST /api/ui/projects', () => {
  it('rejects an anonymous create before it reads the body', async () => {
    // A body that would also fail validation: the status must still be 401, or
    // an anonymous caller learns which slugs are well-formed.
    await expect(
      createHandler(testEvent({ body: { project: 'NOT A SLUG' } }))
    ).rejects.toMatchObject({ statusCode: 401 })
  })
})
