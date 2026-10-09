import { z } from 'zod'
import { verifySignature } from './signature'
import {
  linksForPush,
  markRepositoriesRevoked,
  recordInstallation,
  removeInstallation,
  renameRepository,
  syncEnvironment,
  type SyncDeps
} from '../services/sync'

const pushSchema = z.object({
  ref: z.string(),
  deleted: z.boolean().optional(),
  after: z.string().optional(),
  repository: z.object({ id: z.number(), full_name: z.string() })
})
const installationSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() })
})
const installedSchema = installationSchema.extend({
  installation: z.object({ id: z.number(), account: z.object({ login: z.string().min(1) }) })
})
/** GitHub's actions that leave the installation usable. */
const INSTALLED = new Set(['created', 'unsuspend', 'new_permissions_accepted'])

export type AuditEvent =
  | { action: 'uninstall' }
  | { action: 'install'; installationId: number; account: string }

const reposRemovedSchema = installationSchema.extend({
  repositories_removed: z.array(z.object({ id: z.number() })).default([])
})

/**
 * Pure of h3 so every branch is testable with bytes in and a status out. The
 * signature is checked on the raw body before it is parsed (variables spec §9).
 */
export async function handleWebhook(
  input: { event: string | undefined; signature: string | undefined; rawBody: Uint8Array },
  deps: { secret: string; sync: SyncDeps; audit?: (event: AuditEvent) => Promise<void> }
): Promise<{ status: 202 | 401 | 400; synced: string[] }> {
  if (!verifySignature(deps.secret, input.rawBody, input.signature))
    return { status: 401, synced: [] }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(input.rawBody).toString('utf8'))
  } catch {
    return { status: 400, synced: [] }
  }

  if (input.event === 'push') {
    const push = pushSchema.safeParse(payload)
    if (!push.success) return { status: 400, synced: [] }
    await renameRepository(push.data.repository.id, push.data.repository.full_name)
    if (!push.data.ref.startsWith('refs/heads/')) return { status: 202, synced: [] }
    // A deleted branch has nothing to read; GitHub sends an all-zero `after`.
    if (push.data.deleted || /^0+$/.test(push.data.after ?? '')) return { status: 202, synced: [] }
    const branch = push.data.ref.slice('refs/heads/'.length)
    const environments = await linksForPush(push.data.repository.id, branch)
    // Sequential: a handful of small fetches each, so parallelism would buy
    // nothing but rate limit. GitHub does not redeliver a failed delivery on
    // its own, so one environment's unexpected failure (a network error is a
    // TypeError, which syncEnvironment rethrows) must not skip the rest. It is
    // logged, not recorded on the link.
    const synced: string[] = []
    for (const id of environments) {
      try {
        await syncEnvironment(id, deps.sync)
        synced.push(id)
      } catch (error) {
        console.error(`Webhook sync failed for environment ${id}`, error)
      }
    }
    return { status: 202, synced }
  }

  if (input.event === 'installation') {
    const parsed = installationSchema.safeParse(payload)
    if (parsed.success && parsed.data.action === 'deleted') {
      if (await removeInstallation(parsed.data.installation.id))
        await deps.audit?.({ action: 'uninstall' })
    }
    // The Setup URL redirect needs an admin's session, which an org owner
    // approving a requested install does not have. The signed webhook does
    // not, and the app is installable on this one account only.
    const installed = installedSchema.safeParse(payload)
    if (installed.success && INSTALLED.has(installed.data.action)) {
      const { id, account } = installed.data.installation
      if (await recordInstallation(id, account.login))
        await deps.audit?.({ action: 'install', installationId: id, account: account.login })
    }
    return { status: 202, synced: [] }
  }

  if (input.event === 'installation_repositories') {
    const parsed = reposRemovedSchema.safeParse(payload)
    if (parsed.success && parsed.data.action === 'removed') {
      await markRepositoriesRevoked(
        parsed.data.installation.id,
        parsed.data.repositories_removed.map((r) => r.id)
      )
    }
    return { status: 202, synced: [] }
  }

  return { status: 202, synced: [] }
}
