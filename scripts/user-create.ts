import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { provisioning, provisioningConfig } from './provision'
import { parseCreateUserArgs, resolveRole } from './user-args'

// Run outside Nitro, so nothing has loaded .env yet.
if (existsSync('.env')) process.loadEnvFile('.env')

const USAGE =
  'Usage: pnpm user:create <email> [name] [--role admin|member]\n' +
  '   or: STATESMAN_USER_EMAIL=... [STATESMAN_USER_PASSWORD=...] [STATESMAN_USER_ROLE=...] pnpm user:create\n' +
  '\n' +
  'Roles: admin manages accounts, roles, tokens, locks and history.\n' +
  '       member reads projects, versions and diffs.\n' +
  'Both read every project’s decrypted state. The first account is always an admin.'

let args
try {
  args = parseCreateUserArgs(process.argv.slice(2), process.env)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(`\n${USAGE}`)
  process.exit(2)
}

const { email, name, requestedRole } = args
if (!email) {
  console.error(USAGE)
  process.exit(2)
}

// Generated when not supplied, so the common path does not put a password in
// shell history or in a compose command line.
const supplied = process.env.STATESMAN_USER_PASSWORD
const password = supplied ?? randomBytes(18).toString('base64url')

const admin = provisioning(provisioningConfig())
try {
  const resolved = resolveRole({ requestedRole, deploymentHasAdmin: await admin.hasAdmin() })
  const user = await admin.createUser({ email, password, name, role: resolved.role })

  console.log(`Created user: ${user.email} (${resolved.role})`)
  if (resolved.overrodeRequest) {
    console.log(
      'Made an admin despite --role member: this deployment has no admin, and a\n' +
        'member cannot promote anyone, so that account would have had no way back.'
    )
  } else if (resolved.bootstrapped) {
    console.log('First account on this deployment, so it is an admin.')
  }
  if (!supplied) {
    console.log(`Password: ${password}`)
    console.log('Shown once. Change it under Account, or store it in a password manager.')
  }
} catch (error) {
  // The common failure by far is a duplicate email, and it deserves a sentence
  // rather than a Better Auth stack trace.
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Could not create ${email}: ${message}`)
  process.exitCode = 1
} finally {
  await admin.close()
}
