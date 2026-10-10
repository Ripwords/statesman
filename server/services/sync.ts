import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/client'
import { environment, githubInstallation, project, repositoryLink } from '../db/schema'
import { GitHubError, type GitHubClient } from '../github/client'
import { HclError, type HclToolkit } from '../hcl/toolkit'
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

/**
 * Idempotent: the Setup URL redirect and the `installation` webhook may both
 * report one install. True only when the row is new, so a redelivery is not
 * audited twice. Two statements, but no race to guard: whichever insert wins,
 * the row exists and the update only refreshes the account name.
 */
export async function recordInstallation(
  installationId: number,
  accountLogin: string
): Promise<boolean> {
  const inserted = await db()
    .insert(githubInstallation)
    .values({ installationId, accountLogin })
    .onConflictDoNothing({ target: githubInstallation.installationId })
    .returning()
  if (inserted.length > 0) return true
  await db()
    .update(githubInstallation)
    .set({ accountLogin })
    .where(eq(githubInstallation.installationId, installationId))
  return false
}

/** True when a row was removed, so a replayed delivery can be told from a real uninstall. */
export async function removeInstallation(installationId: number): Promise<boolean> {
  const removed = await db()
    .delete(githubInstallation)
    .where(eq(githubInstallation.installationId, installationId))
    .returning()
  return removed.length > 0
}

export type InstallationSummary = { installationId: number; accountLogin: string }

export async function listInstallations(): Promise<InstallationSummary[]> {
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

const STALE = 'The repository link changed during the sync.'

class SyncConflictError extends Error {}

export type SyncDeps = { client: GitHubClient; hcl: HclToolkit }
export type SyncResult = { ok: true; count: number; sha: string } | { ok: false; error: string }

/**
 * Reads the linked directory at one commit and replaces the declared set
 * (variables spec §9). Failures are RECORDED, not thrown: the caller is a
 * webhook or a button, and either way the answer belongs on the link row where
 * the dashboard shows it. A failure leaves the previous declared set alone,
 * so a bad push cannot mark every variable Undeclared.
 */
export async function syncEnvironment(environmentId: string, deps: SyncDeps): Promise<SyncResult> {
  const [link] = await db()
    .select()
    .from(repositoryLink)
    .where(eq(repositoryLink.environmentId, environmentId))
  if (!link) return { ok: false, error: 'This environment is not linked to a repository.' }

  // The link may be replaced while this sync is in flight; a guarded single
  // statement keeps a stale sync from writing onto the new link's row.
  const unchanged = and(
    eq(repositoryLink.environmentId, environmentId),
    eq(repositoryLink.repoId, link.repoId),
    eq(repositoryLink.ref, link.ref),
    eq(repositoryLink.directory, link.directory)
  )
  try {
    // Every read is pinned to one sha, so a push landing mid-sync cannot mix
    // two commits' files into one declared set.
    const sha = await deps.client.resolveCommit(link.installationId, link.repoFullName, link.ref)
    const paths = await deps.client.listTfFiles(
      link.installationId,
      link.repoFullName,
      link.directory,
      sha
    )
    if (paths.length === 0) {
      throw new GitHubError(
        `No .tf files in ${link.directory || 'the repository root'} at ${link.ref}.`,
        404
      )
    }
    const declared: DeclaredVariable[] = []
    const origin = new Map<string, string>()
    for (const path of paths) {
      const source = await deps.client.readFile(link.installationId, link.repoFullName, path, sha)
      for (const variable of deps.hcl.extractVariables(source, path)) {
        const first = origin.get(variable.name)
        if (first) {
          throw new SyncConflictError(
            first === path
              ? `variable "${variable.name}" is declared twice in ${path}`
              : `variable "${variable.name}" is declared in ${first} and ${path}`
          )
        }
        origin.set(variable.name, path)
        declared.push(variable)
      }
    }
    const written = await db()
      .update(repositoryLink)
      .set({ declared, lastSyncedAt: new Date(), lastSyncedSha: sha, lastSyncError: null })
      .where(unchanged)
      .returning()
    if (written.length === 0) return { ok: false, error: STALE }
    return { ok: true, count: declared.length, sha }
  } catch (error) {
    if (
      !(error instanceof GitHubError) &&
      !(error instanceof HclError) &&
      !(error instanceof SyncConflictError)
    ) {
      throw error
    }
    const message = error.message
    await db().update(repositoryLink).set({ lastSyncError: message }).where(unchanged)
    return { ok: false, error: message }
  }
}

/** Archived projects are read-only, so a push does not re-sync them. */
export async function linksForPush(repoId: number, ref: string): Promise<string[]> {
  const rows = await db()
    .select({ environmentId: repositoryLink.environmentId })
    .from(repositoryLink)
    .innerJoin(environment, eq(environment.id, repositoryLink.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(
      and(
        eq(repositoryLink.repoId, repoId),
        eq(repositoryLink.ref, ref),
        isNull(project.archivedAt)
      )
    )
  return rows.map((r) => r.environmentId)
}

/** Not deleted: an admin may grant the repository back, and the link should resume. */
export async function markRepositoriesRevoked(
  installationId: number,
  repoIds: number[]
): Promise<void> {
  if (repoIds.length === 0) return
  await db()
    .update(repositoryLink)
    .set({ lastSyncError: 'The GitHub App no longer has access to this repository.' })
    .where(
      and(
        eq(repositoryLink.installationId, installationId),
        inArray(repositoryLink.repoId, repoIds)
      )
    )
}

export async function renameRepository(repoId: number, fullName: string): Promise<void> {
  await db()
    .update(repositoryLink)
    .set({ repoFullName: fullName })
    .where(eq(repositoryLink.repoId, repoId))
}
