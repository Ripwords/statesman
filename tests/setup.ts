import { existsSync } from 'node:fs'

// Integration tests talk to the real Postgres and MinIO from docker-compose.yml.
// Node's built-in .env loader keeps this dependency-free.
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

// app/app.config.ts calls defineAppConfig, which Nuxt provides as an
// auto-import. Tests load that file as a plain module, so stand the identity
// function it actually is back up.
const globals = globalThis as typeof globalThis & {
  defineAppConfig?: <T>(config: T) => T
}
globals.defineAppConfig ??= (config) => config
