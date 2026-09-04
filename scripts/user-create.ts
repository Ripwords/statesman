import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { provisioning, provisioningConfig } from './provision'

// Run outside Nitro, so nothing has loaded .env yet.
if (existsSync('.env')) process.loadEnvFile('.env')

const email = process.argv[2] ?? process.env.STATESMAN_USER_EMAIL
if (!email) {
  console.error(
    'Usage: pnpm user:create <email> [name]\n' +
      '   or: STATESMAN_USER_EMAIL=... [STATESMAN_USER_PASSWORD=...] pnpm user:create'
  )
  process.exit(2)
}

const name = process.argv[3] ?? process.env.STATESMAN_USER_NAME
// Generated when not supplied, so the common path does not put a password in
// shell history or in a compose command line.
const supplied = process.env.STATESMAN_USER_PASSWORD
const password = supplied ?? randomBytes(18).toString('base64url')

const admin = provisioning(provisioningConfig())
try {
  const user = await admin.createUser({ email, password, name })
  console.log(`Created user: ${user.email}`)
  if (!supplied) {
    console.log(`Password: ${password}`)
    console.log('Shown once. Sign in and change it, or store it in a password manager.')
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
