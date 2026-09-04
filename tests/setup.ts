import { existsSync } from 'node:fs'

// Integration tests talk to the real Postgres and MinIO from docker-compose.yml.
// Node's built-in .env loader keeps this dependency-free.
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}
