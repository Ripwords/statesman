import { existsSync } from 'node:fs'
import { defineConfig } from 'drizzle-kit'

if (existsSync('.env')) process.loadEnvFile('.env')

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error('DATABASE_URL is required to run drizzle-kit')
}

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url }
})
