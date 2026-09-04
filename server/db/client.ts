import { drizzle as drizzleNode, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { drizzle as drizzleNeon, type NeonHttpDatabase } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import { Pool } from 'pg'
import { env } from '../utils/env'
import { schema } from './schema'

type Schema = typeof schema
export type Database = NodePgDatabase<Schema> | NeonHttpDatabase<Schema>

let instance: Database | undefined

/**
 * Both branches expose the same query builder for everything this project
 * uses. Neon's HTTP driver has no interactive transactions; no code path here
 * needs one, because the lock is a single atomic INSERT ... ON CONFLICT rather
 * than a read-then-write.
 */
export function db(): Database {
  if (instance) return instance
  const config = env()
  instance =
    config.DB_DRIVER === 'neon'
      ? drizzleNeon(neon(config.DATABASE_URL), { schema })
      : drizzleNode(new Pool({ connectionString: config.DATABASE_URL }), { schema })
  return instance
}
