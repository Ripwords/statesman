import { existsSync } from 'node:fs'
import { resolveTestDatabaseUrl, TEST_STORAGE_PATH } from './test-database'

// Integration tests talk to the real Postgres and MinIO from docker-compose.yml.
// Node's built-in .env loader keeps this dependency-free.
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

// Redirect the suites onto their own database and blob root, after .env is read
// and before any test imports server/db/client or server/storage — both memoise
// their connection on first use, so this has to win the race, and being in a
// setupFile is what guarantees it does.
//
// See tests/test-database.ts for why separate stores rather than a teardown.
process.env.DATABASE_URL = resolveTestDatabaseUrl(process.env)
process.env.LOCAL_STORAGE_PATH = TEST_STORAGE_PATH

// app/app.config.ts calls defineAppConfig, which Nuxt provides as an
// auto-import. Tests load that file as a plain module, so stand the identity
// function it actually is back up.
const globals = globalThis as typeof globalThis & {
  defineAppConfig?: <T>(config: T) => T
  defineNitroPlugin?: <T>(plugin: T) => T
}
globals.defineAppConfig ??= (config) => config

// Same story for server/plugins/**: defineNitroPlugin is a Nitro auto-import
// and is likewise the identity function.
globals.defineNitroPlugin ??= (plugin) => plugin
