import { describe, it, expect } from 'vitest'
import { wouldOrphanDeployment } from '../../server/services/users'

/**
 * The lockout this rule prevents has no way back through the application: the
 * deployment keeps serving Terraform perfectly, so nothing looks broken, while
 * every route that could restore an admin is itself admin-only.
 */
describe('wouldOrphanDeployment', () => {
  it('refuses demoting the only admin', () => {
    expect(wouldOrphanDeployment({ currentRole: 'admin', nextRole: 'member', adminCount: 1 })).toBe(
      true
    )
  })

  it('allows demoting an admin while another remains', () => {
    expect(wouldOrphanDeployment({ currentRole: 'admin', nextRole: 'member', adminCount: 2 })).toBe(
      false
    )
  })

  it('allows promoting a member no matter how many admins there are', () => {
    for (const adminCount of [0, 1, 2, 50]) {
      expect(wouldOrphanDeployment({ currentRole: 'member', nextRole: 'admin', adminCount })).toBe(
        false
      )
    }
  })

  it('allows a member staying a member even with no admin anywhere', () => {
    // Nothing is lost, so nothing is refused. The count being zero is somebody
    // else's problem — this function only guards the transition.
    expect(
      wouldOrphanDeployment({ currentRole: 'member', nextRole: 'member', adminCount: 0 })
    ).toBe(false)
  })

  it('allows an admin staying an admin', () => {
    expect(wouldOrphanDeployment({ currentRole: 'admin', nextRole: 'admin', adminCount: 1 })).toBe(
      false
    )
  })

  /**
   * A count of zero with an admin being demoted cannot happen — the target IS
   * an admin, so the count is at least one — but the comparison is `<= 1`
   * rather than `=== 1` so that a miscount can only ever fail closed.
   */
  it('refuses rather than allows if the count is somehow zero', () => {
    expect(wouldOrphanDeployment({ currentRole: 'admin', nextRole: 'member', adminCount: 0 })).toBe(
      true
    )
  })
})
