import { describe, it, expect } from 'vitest'
import type { StateStore } from '../../server/storage/types'

export function conformsToStateStore(name: string, make: () => Promise<StateStore>) {
  describe(`StateStore conformance: ${name}`, () => {
    it('returns null for a missing key', async () => {
      expect(await (await make()).get('nope/missing.bin')).toBeNull()
    })

    it('round-trips bytes', async () => {
      const s = await make()
      const data = new Uint8Array([1, 2, 3, 250, 0, 128])
      await s.put('a/b.bin', data)
      expect(Buffer.from((await s.get('a/b.bin'))!)).toEqual(Buffer.from(data))
    })

    it('lists by prefix and excludes other prefixes', async () => {
      const s = await make()
      await s.put('p1/one.bin', new Uint8Array([1]))
      await s.put('p1/two.bin', new Uint8Array([2]))
      await s.put('p2/three.bin', new Uint8Array([3]))
      const keys = (await s.list('p1/')).sort()
      expect(keys).toEqual(['p1/one.bin', 'p1/two.bin'])
    })

    it('deletes a key', async () => {
      const s = await make()
      await s.put('gone.bin', new Uint8Array([9]))
      await s.delete('gone.bin')
      expect(await s.get('gone.bin')).toBeNull()
    })

    it('deleting a missing key is not an error', async () => {
      await expect((await make()).delete('never/existed.bin')).resolves.toBeUndefined()
    })

    it('handles a large payload', async () => {
      const s = await make()
      const big = new Uint8Array(5 * 1024 * 1024).fill(42)
      await s.put('big.bin', big)
      expect((await s.get('big.bin'))!.length).toBe(big.length)
    })
  })
}
