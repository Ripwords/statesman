import type { Database } from './client'
import { projectAccess } from './schema'

/**
 * Creates the plugin's access row for a project that lacks one (spec §4: a
 * crash between the two inserts). Idempotent.
 *
 * Takes the database rather than reaching for server/db/client, so
 * scripts/seed.ts can call it without env() and the secrets it demands.
 * Routes use `ensureAccessRecord` in server/utils/project-access.ts.
 */
export async function ensureAccessRecordIn(
  database: Database,
  projectId: string,
  name: string
): Promise<void> {
  await database
    .insert(projectAccess)
    .values({ id: projectId, name, slug: projectId })
    .onConflictDoNothing({ target: projectAccess.id })
}
