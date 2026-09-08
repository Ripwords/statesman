import { describe, it, expect } from 'vitest'
import { parseCreateUserArgs, resolveRole } from '../../scripts/user-args'

describe('parseCreateUserArgs', () => {
  it('reads email and name positionally', () => {
    expect(parseCreateUserArgs(['you@example.com', 'Your Name'], {})).toMatchObject({
      email: 'you@example.com',
      name: 'Your Name',
      requestedRole: undefined
    })
  })

  it('accepts --role admin', () => {
    expect(parseCreateUserArgs(['you@example.com', '--role', 'admin'], {}).requestedRole).toBe(
      'admin'
    )
  })

  it('accepts --role=member', () => {
    expect(parseCreateUserArgs(['you@example.com', '--role=member'], {}).requestedRole).toBe(
      'member'
    )
  })

  /**
   * The flag has to come out of the positional list, or `pnpm user:create
   * you@example.com --role admin` reads "--role" as the person's display name.
   */
  it('does not leave the flag behind as the name', () => {
    const parsed = parseCreateUserArgs(['you@example.com', '--role', 'admin'], {})
    expect(parsed.name).toBeUndefined()
  })

  it('keeps a name given after the flag', () => {
    const parsed = parseCreateUserArgs(['you@example.com', '--role=admin', 'Your Name'], {})
    expect(parsed).toMatchObject({
      email: 'you@example.com',
      name: 'Your Name',
      requestedRole: 'admin'
    })
  })

  it('falls back to the environment when no positional argument is given', () => {
    expect(
      parseCreateUserArgs([], {
        STATESMAN_USER_EMAIL: 'env@example.com',
        STATESMAN_USER_NAME: 'Env Name',
        STATESMAN_USER_ROLE: 'member'
      })
    ).toMatchObject({ email: 'env@example.com', name: 'Env Name', requestedRole: 'member' })
  })

  it('rejects a role that is not one of the two', () => {
    expect(() => parseCreateUserArgs(['you@example.com', '--role', 'root'], {})).toThrow(/root/)
  })

  it('rejects --role with nothing after it', () => {
    expect(() => parseCreateUserArgs(['you@example.com', '--role'], {})).toThrow(/--role/)
  })
})

describe('resolveRole', () => {
  it('makes the first account an admin, because nothing else could promote it', () => {
    expect(resolveRole({ requestedRole: undefined, deploymentHasAdmin: false })).toEqual({
      role: 'admin',
      bootstrapped: true,
      overrodeRequest: false
    })
  })

  it('defaults to member once an admin exists', () => {
    expect(resolveRole({ requestedRole: undefined, deploymentHasAdmin: true })).toEqual({
      role: 'member',
      bootstrapped: false,
      overrodeRequest: false
    })
  })

  it('honours an explicit role once an admin exists', () => {
    expect(resolveRole({ requestedRole: 'admin', deploymentHasAdmin: true })).toEqual({
      role: 'admin',
      bootstrapped: false,
      overrodeRequest: false
    })
    expect(resolveRole({ requestedRole: 'member', deploymentHasAdmin: true })).toEqual({
      role: 'member',
      bootstrapped: false,
      overrodeRequest: false
    })
  })

  /**
   * `--role member` on an empty deployment asks for something with no way back:
   * a deployment whose only account cannot manage accounts, tokens or locks,
   * and no admin anywhere to fix it. The request is overridden and reported
   * rather than honoured silently.
   */
  it('overrides an explicit member request when there is no admin at all', () => {
    expect(resolveRole({ requestedRole: 'member', deploymentHasAdmin: false })).toEqual({
      role: 'admin',
      bootstrapped: true,
      overrodeRequest: true
    })
  })
})
