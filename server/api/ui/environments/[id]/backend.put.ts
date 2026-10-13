import { z } from 'zod'
import { requireSession } from '../../../../utils/ui-auth'
import { projectIdOfEnvironment, requireProjectPermission } from '../../../../utils/project-access'
import { environmentContext, setBackend } from '../../../../services/variables'
import { recordAuditBestEffort } from '../../../../services/audit'
import { hcl } from '../../../../hcl'
import { HclError } from '../../../../hcl/toolkit'
import {
  backendSettingsSchema,
  firstIssueMessage,
  putBackendSchema,
  type BackendSettings
} from '../../../../../shared/schemas/backend'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

function badRequest(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message })
}

/** Backend settings (checkout spec §4). JSON or pasted HCL; empty HCL clears. */
export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const session = await requireProjectPermission(
    event,
    await projectIdOfEnvironment(id),
    'environment:configure'
  )
  const body = putBackendSchema.safeParse(await readValidatedBody(event, (raw) => raw))
  if (!body.success) badRequest(firstIssueMessage(body.error))

  let backend: BackendSettings | null
  if ('backend' in body.data) {
    backend = body.data.backend
  } else if (body.data.hcl.trim() === '') {
    backend = null
  } else {
    let parsed: unknown
    try {
      parsed = (await hcl()).parseTfvars(body.data.hcl)
    } catch (error) {
      if (error instanceof HclError) badRequest(error.message)
      throw error
    }
    const checked = backendSettingsSchema.safeParse(parsed)
    if (!checked.success) badRequest(firstIssueMessage(checked.error))
    backend = checked.data
  }

  const ctx = await environmentContext(id)
  await setBackend(id, backend)
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'environment.backend.update',
    meta: { environment: ctx.slug, keys: backend ? Object.keys(backend) : [] }
  })
  return { backend }
})
