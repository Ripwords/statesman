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
  await db().insert(auditLog).values({
    id: ulid(),
    orgId: entry.orgId,
    projectId: entry.projectId ?? null,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    metaJson: entry.meta ?? null
  })
}
