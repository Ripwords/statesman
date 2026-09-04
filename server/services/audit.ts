import { ulid } from 'ulid'
import { db } from '../db/client'
import { auditLog } from '../db/schema'

export type AuditEntry = {
  orgId: string
  projectId?: string
  actorType: 'user' | 'api-key'
  actorId?: string
  action: string
  meta?: Record<string, unknown>
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  await db()
    .insert(auditLog)
    .values({
      id: ulid(),
      orgId: entry.orgId,
      projectId: entry.projectId ?? null,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      metaJson: entry.meta ?? null
    })
}

/**
 * Records the entry, and swallows the failure if it cannot.
 *
 * Every audit write in this codebase runs AFTER the operation it describes has
 * already been committed — the state bytes are stored, the lock row is in, the
 * pointer has moved. Letting the audit insert decide the response status turns
 * a durable success into a 500, and the caller reacts to that 500 by retrying:
 * Terraform re-POSTs the same state and the history gains a duplicate version,
 * or it gives up on a lock it is actually holding and the next run needs a
 * force-unlock. Losing one observability row is strictly cheaper than either.
 *
 * The failure is not silent — it goes to the server log, where an operator
 * looking for a gap in the audit trail will find the reason.
 *
 * The distinction is the point: use `recordAudit` where the audit row is part
 * of what the caller asked for, and this where it is a record of work already
 * done.
 */
export async function recordAuditBestEffort(entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(entry)
  } catch (error) {
    console.error(
      `[statesman] audit write failed for ${entry.action}`,
      { orgId: entry.orgId, projectId: entry.projectId, actorType: entry.actorType },
      error
    )
  }
}
