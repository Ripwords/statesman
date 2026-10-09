import { describe, it, expect } from 'vitest'
import { statusMessageOf } from '../../app/utils/status-message'

describe('statusMessageOf', () => {
  it('returns the server statusMessage verbatim', () => {
    const error = Object.assign(new Error('400 Bad Request'), {
      statusMessage: 'HCL import is not available yet.'
    })
    expect(statusMessageOf(error, 'fallback')).toBe('HCL import is not available yet.')
  })
  it('reads statusMessage from any error-shaped object, such as a NuxtError', () => {
    expect(statusMessageOf({ statusMessage: 'No variable named x' }, 'fallback')).toBe(
      'No variable named x'
    )
  })
  it.each([
    ['a plain Error', new Error('network')],
    ['an empty statusMessage', { statusMessage: '' }],
    ['a non-string statusMessage', { statusMessage: 404 }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'oops']
  ])('falls back for %s', (_label, error) => {
    expect(statusMessageOf(error, 'fallback')).toBe('fallback')
  })
})
