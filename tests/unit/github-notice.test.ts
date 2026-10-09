import { describe, it, expect } from 'vitest'
import type { LocationQuery } from 'vue-router'
import { githubNotice } from '../../app/utils/github-notice'

describe('githubNotice', () => {
  it('confirms a completed install', () => {
    expect(githubNotice({ github: 'connected' })).toMatchObject({
      title: 'GitHub Connected',
      color: 'success'
    })
  })

  it('explains a request waiting for an organisation owner', () => {
    expect(githubNotice({ github: 'requested' })).toMatchObject({
      title: 'Installation Requested',
      description: expect.stringContaining('owner')
    })
  })

  const silent: LocationQuery[] = [{}, { github: 'other' }, { github: ['connected', 'connected'] }]
  it.each(silent)('says nothing for %j', (query) => {
    expect(githubNotice(query)).toBeNull()
  })
})
