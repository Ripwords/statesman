import { eq, and } from 'drizzle-orm'
import { db } from '../db/client'
import { stateLock } from '../db/schema'
import { lockInfoSchema, type LockInfo } from '../../shared/schemas/lock'

export type AcquireResult = { ok: true } | { ok: false; held: LockInfo }

export async function acquireLock(projectId: string, info: LockInfo): Promise<AcquireResult> {
  // Single atomic statement. Two concurrent callers cannot both insert, because
  // project_id is the primary key. No transaction, no advisory lock, no read
  // before write — which is what makes this correct on Neon's HTTP driver too.
  const inserted = await db()
    .insert(stateLock)
    .values({
      projectId,
      lockId: info.ID,
      who: info.Who ?? null,
      operation: info.Operation ?? null,
      version: info.Version ?? null,
      infoJson: info
    })
    .onConflictDoNothing({ target: stateLock.projectId })
    // `returning()` takes no argument here: Database is a union of the node-pg
    // and neon-http builders, and only the zero-argument overload is common to
    // both. We want the row count, not the columns.
    .returning()

  if (inserted.length > 0) return { ok: true }

  const held = await currentLock(projectId)
  // The holder released between our insert and this read. Report the conflict
  // anyway: Terraform retries, and inventing a success we did not achieve is
  // the one outcome that could corrupt state.
  return { ok: false, held: held ?? { ID: 'unknown' } }
}

export async function releaseLock(projectId: string, lockId: string): Promise<boolean> {
  const deleted = await db()
    .delete(stateLock)
    .where(and(eq(stateLock.projectId, projectId), eq(stateLock.lockId, lockId)))
    .returning()
  return deleted.length > 0
}

export async function forceReleaseLock(projectId: string): Promise<void> {
  await db().delete(stateLock).where(eq(stateLock.projectId, projectId))
}

export async function currentLock(projectId: string): Promise<LockInfo | null> {
  const rows = await db().select().from(stateLock).where(eq(stateLock.projectId, projectId))
  const row = rows[0]
  if (!row) return null
  const parsed = lockInfoSchema.safeParse(row.infoJson)
  return parsed.success ? parsed.data : { ID: row.lockId }
}
