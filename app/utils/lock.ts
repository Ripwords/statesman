/** The lock columns the project list joins in. Both are nullable in the row. */
export type LockSummary = {
  lockedBy: string | null
  lockedAt: string | Date | null
}

/**
 * Whether a lock is held.
 *
 * `lockedAt` and not `lockedBy`: state_lock.created_at is notNull by
 * construction, while `who` comes straight from Terraform's LockInfo, where
 * every field but `ID` is optional (shared/schemas/lock.ts). Any client that
 * omits `Who` — an older CLI, third-party tooling, a bare curl — produced a
 * genuinely held lock that the dashboard rendered as no lock at all: no badge,
 * no banner, and therefore no Force Unlock button, so the lock could not be
 * cleared from the UI at all.
 */
export function isLocked(row: LockSummary): boolean {
  return row.lockedAt !== null
}

/** The holder's name, or an honest stand-in when the client did not send one. */
export function lockHolder(row: LockSummary): string {
  return row.lockedBy ?? 'an unknown process'
}
