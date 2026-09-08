import { describe, it, expect } from 'vitest'
import { deriveTestDatabaseUrl, resolveTestDatabaseUrl } from '../test-database'

describe('deriveTestDatabaseUrl', () => {
  it('appends _test to the database name', () => {
    expect(deriveTestDatabaseUrl('postgres://u:p@localhost:5432/statesman')).toBe(
      'postgres://u:p@localhost:5432/statesman_test'
    )
  })

  it('keeps credentials, host, port and query parameters', () => {
    const url = deriveTestDatabaseUrl('postgres://u:p@db.example.com:6543/app?sslmode=require')
    expect(url).toBe('postgres://u:p@db.example.com:6543/app_test?sslmode=require')
  })

  it('refuses a connection string with no database name', () => {
    expect(() => deriveTestDatabaseUrl('postgres://u:p@localhost:5432')).toThrow(/no database name/)
  })
})

describe('resolveTestDatabaseUrl', () => {
  it('derives from DATABASE_URL when no override is given', () => {
    expect(
      resolveTestDatabaseUrl({ DATABASE_URL: 'postgres://u:p@localhost:5432/statesman' })
    ).toBe('postgres://u:p@localhost:5432/statesman_test')
  })

  it('prefers an explicit TEST_DATABASE_URL', () => {
    expect(
      resolveTestDatabaseUrl({
        DATABASE_URL: 'postgres://u:p@localhost:5432/statesman',
        TEST_DATABASE_URL: 'postgres://u:p@ci:5432/ci_db'
      })
    ).toBe('postgres://u:p@ci:5432/ci_db')
  })

  it('treats an empty override as unset rather than as a URL', () => {
    expect(
      resolveTestDatabaseUrl({
        DATABASE_URL: 'postgres://u:p@localhost:5432/statesman',
        TEST_DATABASE_URL: ''
      })
    ).toBe('postgres://u:p@localhost:5432/statesman_test')
  })

  it('refuses an override that points at the development database', () => {
    const url = 'postgres://u:p@localhost:5432/statesman'
    expect(() => resolveTestDatabaseUrl({ DATABASE_URL: url, TEST_DATABASE_URL: url })).toThrow(
      /same as DATABASE_URL/
    )
  })

  it('requires DATABASE_URL', () => {
    expect(() => resolveTestDatabaseUrl({})).toThrow(/DATABASE_URL is required/)
  })
})
