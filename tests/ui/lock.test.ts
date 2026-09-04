import { describe, expect, it } from 'vitest'
import { isLocked, lockHolder } from '../../app/utils/lock'

describe('isLocked', () => {
  it('reports a lock held by a named client', () => {
    expect(isLocked({ lockedBy: 'jj@laptop', lockedAt: '2026-09-04T00:00:00Z' })).toBe(true)
  })

  it('reports a lock whose client sent no Who', () => {
    // The regression: gating on lockedBy hid a genuinely held lock completely —
    // no badge, no banner, and so no way to force-unlock it from the UI. Every
    // LockInfo field except ID is optional, so this is a supported client.
    expect(isLocked({ lockedBy: null, lockedAt: '2026-09-04T00:00:00Z' })).toBe(true)
  })

  it('reports no lock when nothing is held', () => {
    expect(isLocked({ lockedBy: null, lockedAt: null })).toBe(false)
  })

  it('accepts a Date as well as the serialised string', () => {
    expect(isLocked({ lockedBy: null, lockedAt: new Date() })).toBe(true)
  })
})

describe('lockHolder', () => {
  it('names the holder when the client sent one', () => {
    expect(lockHolder({ lockedBy: 'ci@runner-3', lockedAt: 'x' })).toBe('ci@runner-3')
  })

  it('stands in for a client that sent no Who', () => {
    expect(lockHolder({ lockedBy: null, lockedAt: 'x' })).toBe('an unknown process')
  })
})
