import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../../db/client'
import { project } from '../../../../db/schema'
import { requireSession } from '../../../../utils/ui-auth'
import { requireProjectPermission } from '../../../../utils/project-access'
import { createEnvironment } from '../../../../services/variables'
import { recordAuditBestEffort } from '../../../../services/audit'
import { createEnvironmentSchema } from '../../../../../shared/schemas/variable'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const session = await requireProjectPermission(event, id, 'environment:create')
  const { slug } = await readValidatedBody(event, createEnvironmentSchema.parse)
  const [owner] = await db()
    .select({ orgId: project.orgId })
    .from(project)
    .where(eq(project.id, id))
  if (!owner) throw createError({ statusCode: 404, statusMessage: 'Unknown project' })
  const created = await createEnvironment(id, slug)
  await recordAuditBestEffort({
    orgId: owner.orgId,
    projectId: id,
    actorType: 'user',
    actorId: session.userId,
    action: 'environment.create',
    meta: { environment: slug }
  })
  return created
})
