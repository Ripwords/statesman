import { z } from 'zod'
import { verifySignature } from './signature'
import {
  linksForPush,
  markRepositoriesRevoked,
  removeInstallation,
  renameRepository,
  syncEnvironment,
  type SyncDeps
} from '../services/sync'

const pushSchema = z.object({
  ref: z.string(),
  repository: z.object({ id: z.number(), full_name: z.string() })
})
const repositoryEventSchema = z.object({
  action: z.string(),
  repository: z.object({ id: z.number(), full_name: z.string() })
})
const installationSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() })
})
const reposRemovedSchema = installationSchema.extend({
  repositories_removed: z.array(z.object({ id: z.number() })).default([])
})

/**
 * Pure of h3 so every branch is testable with bytes in and a status out. The
 * signature is checked on the raw body before it is parsed (variables spec §9).
 */
export async function handleWebhook(
  input: { event: string | undefined; signature: string | undefined; rawBody: Uint8Array },
  deps: { secret: string; sync: SyncDeps; audit?: (event: 'uninstall') => Promise<void> }
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
    const branch = push.data.ref.slice('refs/heads/'.length)
    const environments = await linksForPush(push.data.repository.id, branch)
    // Sequential: a handful of small fetches each, and GitHub retries a
    // delivery that times out, so parallelism would buy nothing but rate limit.
    for (const id of environments) await syncEnvironment(id, deps.sync)
    return { status: 202, synced: environments }
  }

  if (input.event === 'installation') {
    const parsed = installationSchema.safeParse(payload)
    if (parsed.success && parsed.data.action === 'deleted') {
      await removeInstallation(parsed.data.installation.id)
      await deps.audit?.('uninstall')
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

  if (input.event === 'repository') {
    const parsed = repositoryEventSchema.safeParse(payload)
    if (parsed.success && parsed.data.action === 'renamed')
      await renameRepository(parsed.data.repository.id, parsed.data.repository.full_name)
    return { status: 202, synced: [] }
  }

  return { status: 202, synced: [] }
}
