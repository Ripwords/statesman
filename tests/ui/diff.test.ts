import { describe, expect, it } from 'vitest'
import { diffJson } from '../../app/utils/diff'

describe('diffJson', () => {
  it('reports no changes for identical documents', () => {
    const doc = { a: 1, b: 'x' }
    expect(diffJson(doc, { ...doc }).filter((l) => l.kind !== 'same')).toHaveLength(0)
  })

  it('detects an added key', () => {
    const changes = diffJson({ a: 1 }, { a: 1, b: 2 })
    expect(changes).toContainEqual({ kind: 'add', path: 'b', value: '2' })
  })

  it('detects a removed key', () => {
    const changes = diffJson({ a: 1, b: 2 }, { a: 1 })
    expect(changes).toContainEqual({ kind: 'remove', path: 'b', value: '2' })
  })

  it('detects a changed value as a remove plus an add', () => {
    const changes = diffJson({ a: 1 }, { a: 2 })
    expect(changes).toContainEqual({ kind: 'remove', path: 'a', value: '1' })
    expect(changes).toContainEqual({ kind: 'add', path: 'a', value: '2' })
  })

  it('walks into nested objects and arrays', () => {
    const changes = diffJson(
      { resources: [{ name: 'db', id: 'old' }] },
      { resources: [{ name: 'db', id: 'new' }] }
    )
    expect(changes.some((l) => l.path === 'resources.0.id' && l.kind === 'add')).toBe(true)
  })

  it('handles null on either side', () => {
    expect(() => diffJson(null, { a: 1 })).not.toThrow()
    expect(() => diffJson({ a: 1 }, null)).not.toThrow()
  })

  it('distinguishes an empty container from a missing one', () => {
    expect(diffJson({ tags: {} }, { tags: [] })).toContainEqual({
      kind: 'remove', path: 'tags', value: '{}'
    })
    expect(diffJson({ tags: {} }, { tags: [] })).toContainEqual({
      kind: 'add', path: 'tags', value: '[]'
    })
  })

  it('orders lines by path so a diff reads top to bottom', () => {
    const paths = diffJson({ b: 1, a: 1 }, { b: 2, a: 2 }).map((l) => l.path)
    expect(paths).toEqual(['a', 'a', 'b', 'b'])
  })
})
