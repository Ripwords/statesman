import { userRoleSchema, type UserRole } from '../shared/schemas/user'

export type CreateUserArgs = {
  email: string | undefined
  name: string | undefined
  requestedRole: UserRole | undefined
}

/**
 * Parses `pnpm user:create <email> [name] [--role admin|member]`.
 *
 * The flag is pulled out of the list before the positional arguments are read.
 * Left in, `user:create you@example.com --role admin` would take `--role` as
 * the person's display name and `admin` as an argument nothing consumes — a
 * silently wrong account rather than an error.
 */
export function parseCreateUserArgs(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): CreateUserArgs {
  const positional: string[] = []
  let requested: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (arg === '--role') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--role needs a value: --role admin or --role member')
      }
      requested = value
      i++
      continue
    }
    if (arg.startsWith('--role=')) {
      requested = arg.slice('--role='.length)
      continue
    }
    positional.push(arg)
  }

  const rawRole = requested ?? environment.STATESMAN_USER_ROLE
  let requestedRole: UserRole | undefined
  if (rawRole !== undefined && rawRole !== '') {
    const parsed = userRoleSchema.safeParse(rawRole)
    if (!parsed.success) {
      throw new Error(`"${rawRole}" is not a role. Use --role admin or --role member.`)
    }
    requestedRole = parsed.data
  }

  return {
    email: positional[0] ?? environment.STATESMAN_USER_EMAIL,
    name: positional[1] ?? environment.STATESMAN_USER_NAME,
    requestedRole
  }
}

export type ResolvedRole = {
  role: UserRole
  /** True when this account is an admin only because the deployment had none. */
  bootstrapped: boolean
  /** True when that bootstrap overrode an explicit `--role member`. */
  overrodeRequest: boolean
}

/**
 * Decides the role a new account gets.
 *
 * The first account is always an admin. Accounts are only ever made by an
 * operator with database access, and a deployment whose sole account cannot
 * manage accounts, tokens or locks has no way back: there is no admin left to
 * promote anyone. So an explicit `--role member` on an empty deployment is
 * overridden rather than honoured — and reported, so the override is never a
 * surprise.
 */
export function resolveRole(input: {
  requestedRole: UserRole | undefined
  deploymentHasAdmin: boolean
}): ResolvedRole {
  if (!input.deploymentHasAdmin) {
    return {
      role: 'admin',
      bootstrapped: true,
      overrodeRequest: input.requestedRole === 'member'
    }
  }
  return {
    role: input.requestedRole ?? 'member',
    bootstrapped: false,
    overrodeRequest: false
  }
}
