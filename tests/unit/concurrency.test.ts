import { describe, it, expect } from 'vitest'
import { mapWithConcurrency } from '../../server/utils/concurrency'

/** Resolves only when `release()` is called, so a test controls when work finishes. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('mapWithConcurrency', () => {
  it('returns results in input order, not completion order', async () => {
    const out = await mapWithConcurrency([30, 10, 20, 0], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    expect(out).toEqual([30, 10, 20, 0])
  })

  it('never runs more than `limit` tasks at once', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(
      Array.from({ length: 50 }, (_, i) => i),
      4,
      async (i) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, i % 3))
        inFlight--
        return i
      }
    )
    expect(peak).toBe(4)
  })

  it('starts exactly `limit` tasks before any of them finishes', async () => {
    // The regression this guards: Promise.all(items.map(...)) starts every task
    // immediately, so `started` would be 6 rather than 2.
    const held = gate()
    let started = 0
    const running = mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started++
      await held.promise
      return n
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(started).toBe(2)
    held.release()
    expect(await running).toEqual([1, 2, 3, 4, 5, 6])
    expect(started).toBe(6)
  })

  it('handles an empty list without starting a worker', async () => {
    let calls = 0
    expect(
      await mapWithConcurrency([], 4, async (x: number) => {
        calls++
        return x
      })
    ).toEqual([])
    expect(calls).toBe(0)
  })

  it('caps the worker count at the item count', async () => {
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n * 2)).toEqual([2, 4])
  })

  it('propagates a task failure', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      })
    ).rejects.toThrow('boom')
  })

  it('rejects a limit below one rather than hanging', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(/limit/)
  })
})
