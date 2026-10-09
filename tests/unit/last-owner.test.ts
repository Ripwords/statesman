import { describe, it, expect } from 'vitest'
import { leavesNoOwner } from '../../app/utils/last-owner'

describe('leavesNoOwner', () => {
  it('is true when the only owner is demoted', () => {
    expect(leavesNoOwner('owner', 'editor', 1)).toBe(true)
    expect(leavesNoOwner('owner', 'viewer', 1)).toBe(true)
  })

  it('is false while another owner remains', () => {
    expect(leavesNoOwner('owner', 'editor', 2)).toBe(false)
  })

  it('is false when the role stays owner or the member was not an owner', () => {
    expect(leavesNoOwner('owner', 'owner', 1)).toBe(false)
    expect(leavesNoOwner('editor', 'viewer', 1)).toBe(false)
    expect(leavesNoOwner('viewer', 'owner', 0)).toBe(false)
  })
})
