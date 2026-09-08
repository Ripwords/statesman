import { describe, it, expect } from 'vitest'
import { userRoleSchema, roleOf, isAdmin, type UserRole } from '../../shared/schemas/user'

describe('userRoleSchema', () => {
  it('accepts the two roles this deployment has', () => {
    expect(userRoleSchema.parse('admin')).toBe('admin')
    expect(userRoleSchema.parse('member')).toBe('member')
  })

  it('rejects anything else, including better-auth’s own default name', () => {
    // The admin plugin's built-in default is "user"; ours is "member", and a
    // row carrying the plugin's name must not be silently accepted as valid.
    expect(userRoleSchema.safeParse('user').success).toBe(false)
    expect(userRoleSchema.safeParse('owner').success).toBe(false)
    expect(userRoleSchema.safeParse('').success).toBe(false)
  })
})

describe('roleOf', () => {
  it('reads a known role back', () => {
    expect(roleOf('admin')).toBe('admin')
    expect(roleOf('member')).toBe('member')
  })

  /**
   * `user.role` is nullable — the admin plugin declares it `required: false`,
   * and a row written before the column existed has NULL in it. Every unknown
   * value has to land on the least privilege available, because the alternative
   * is a typo in the database granting administration.
   */
  it('treats null, undefined and unrecognised values as member', () => {
    expect(roleOf(null)).toBe('member')
    expect(roleOf(undefined)).toBe('member')
    expect(roleOf('administrator')).toBe('member')
    expect(roleOf('ADMIN')).toBe('member')
    expect(roleOf('user')).toBe('member')
  })
})

describe('isAdmin', () => {
  it('is true only for the admin role', () => {
    expect(isAdmin('admin')).toBe(true)
    expect(isAdmin('member')).toBe(false)
  })

  it('is false for every value that is not a role at all', () => {
    expect(isAdmin(null)).toBe(false)
    expect(isAdmin(undefined)).toBe(false)
    expect(isAdmin('ADMIN')).toBe(false)
  })
})

describe('the role list', () => {
  it('is exhaustive, so a new role cannot be added without updating the guard', () => {
    const all: UserRole[] = ['admin', 'member']
    expect(userRoleSchema.options).toEqual(all)
  })
})
