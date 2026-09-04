import { authenticateTf, authorizeTf } from '../../../../utils/tf-auth'
import {
  refFromEvent,
  resolveProject,
  handleLockAcquire,
  handleLockRelease,
  lockIdQuerySchema
} from '../../../../utils/tf-handler'
import { readCurrentState, writeState, purgeState } from '../../../../services/state'
import { recordAudit } from '../../../../services/audit'
import { currentLock } from '../../../../services/lock'
import type { StateAction } from '../../../../../shared/schemas/token'

const ACTION_FOR_METHOD: Record<string, StateAction> = {
  GET: 'read', POST: 'write', DELETE: 'delete', LOCK: 'lock', UNLOCK: 'lock'
}

export default defineEventHandler(async (event) => {
  const method = event.method.toUpperCase()
  const action = ACTION_FOR_METHOD[method]
  if (!action) throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })

  // Spec §9 order, and it is load-bearing: credentials first, so an anonymous
  // caller cannot tell an existing project (401) from a missing one (404) and
  // no unauthenticated request reaches the database.
  const principal = await authenticateTf(event)
  const ref = await refFromEvent(event)
  const resolved = await resolveProject(ref)
  authorizeTf(principal, ref, action)

  if (method === 'GET') {
    const body = await readCurrentState(resolved.id)
    // "No state yet" is a normal condition Terraform expects as a 404, not an
    // error worth logging (spec §2).
    if (!body) throw createError({ statusCode: 404, statusMessage: 'No state' })
    setResponseHeader(event, 'content-type', 'application/json')
    return body
  }

  // Terraform can be configured to send LOCK/UNLOCK to the base address.
  if (method === 'LOCK') return handleLockAcquire(event, resolved, principal)
  if (method === 'UNLOCK') return handleLockRelease(event, resolved, principal)

  if (method === 'POST') {
    const held = await currentLock(resolved.id)
    if (held) {
      const { ID } = await getValidatedQuery(event, lockIdQuerySchema.parse)
      if (ID !== held.ID) {
        // Same reasoning as the 423: spec §11 requires the lock info JSON as
        // the body so the CLI can name the holder.
        setResponseStatus(event, 409)
        return held
      }
    }

    // The state document is Terraform's, not ours. It is read raw and never
    // passed through Zod (spec §12); `serial` and `lineage` are peeked at for
    // display only, inside writeState.
    const raw = await readRawBody(event, false)
    const body = raw ?? Buffer.alloc(0)
    const { versionId } = await writeState({
      projectId: resolved.id,
      orgSlug: ref.org,
      projectSlug: ref.project,
      body,
      userId: principal.userId
    })
    await recordAudit({
      orgId: resolved.orgId, projectId: resolved.id, actorType: 'api-key',
      actorId: principal.keyId, action: 'state.write', meta: { versionId, bytes: body.length }
    })
    return { ok: true }
  }

  await purgeState(resolved.id)
  await recordAudit({
    orgId: resolved.orgId, projectId: resolved.id, actorType: 'api-key',
    actorId: principal.keyId, action: 'state.purge'
  })
  return { ok: true }
})
