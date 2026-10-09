import { describe, it, expect } from 'vitest'
import { firstSyncFailure, linkDescription } from '../../app/utils/repository-link'

describe('linkDescription', () => {
  it('joins repository, ref and a slash-prefixed directory', () => {
    expect(
      linkDescription({ repoFullName: 'acme/infra', ref: 'main', directory: 'envs/prod' })
    ).toBe('acme/infra · main · /envs/prod')
  })
  it('shows the repository root as a bare slash', () => {
    expect(linkDescription({ repoFullName: 'acme/infra', ref: 'main', directory: '' })).toBe(
      'acme/infra · main · /'
    )
  })
})

describe('firstSyncFailure', () => {
  it('says the link was saved before naming the sync error', () => {
    expect(firstSyncFailure('No such directory: envs/prod')).toBe(
      'Linked. The first sync failed: No such directory: envs/prod'
    )
  })
})
