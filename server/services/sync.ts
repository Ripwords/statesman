import { asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { githubInstallation, repositoryLink } from '../db/schema'
import type { DeclaredVariable } from '../../shared/schemas/variable'
import type { LinkSummary } from '../utils/variable-status'

export function normaliseDirectory(input: string): string {
  const parts = input.split('/').filter(Boolean)
  if (parts.some((p) => p === '..' || p === '.')) {
    throw createError({
      statusCode: 400,
      statusMessage: 'The directory may not contain . or .. segments.'
    })
  }
  return parts.join('/')
}

export async function recordInstallation(
  installationId: number,
  accountLogin: string
): Promise<void> {
  await db()
    .insert(githubInstallation)
    .values({ installationId, accountLogin })
    .onConflictDoUpdate({ target: githubInstallation.installationId, set: { accountLogin } })
}

export async function removeInstallation(installationId: number): Promise<void> {
  await db().delete(githubInstallation).where(eq(githubInstallation.installationId, installationId))
}

export async function listInstallations(): Promise<
  Array<{ installationId: number; accountLogin: string }>
> {
  return db()
    .select({
      installationId: githubInstallation.installationId,
      accountLogin: githubInstallation.accountLogin
    })
    .from(githubInstallation)
    .orderBy(asc(githubInstallation.accountLogin))
}

/** Relinking resets the sync state: a declared set from another repo or branch means nothing here. */
export async function linkRepository(args: {
  environmentId: string
  installationId: number
  repoId: number
  repoFullName: string
  ref: string
  directory: string
}): Promise<void> {
  const values = { ...args, directory: normaliseDirectory(args.directory) }
  const reset = { lastSyncedAt: null, lastSyncedSha: null, lastSyncError: null, declared: null }
  await db()
    .insert(repositoryLink)
    .values({ ...values, ...reset })
    .onConflictDoUpdate({ target: repositoryLink.environmentId, set: { ...values, ...reset } })
}

export async function unlinkRepository(environmentId: string): Promise<boolean> {
  const deleted = await db()
    .delete(repositoryLink)
    .where(eq(repositoryLink.environmentId, environmentId))
    .returning()
  return deleted.length > 0
}

export async function linkSummary(
  environmentId: string
): Promise<{ summary: LinkSummary; declared: DeclaredVariable[] | null } | null> {
  const [row] = await db()
    .select()
    .from(repositoryLink)
    .where(eq(repositoryLink.environmentId, environmentId))
  if (!row) return null
  return {
    summary: {
      repoFullName: row.repoFullName,
      ref: row.ref,
      directory: row.directory,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastSyncedSha: row.lastSyncedSha,
      lastSyncError: row.lastSyncError
    },
    declared: row.declared
  }
}
