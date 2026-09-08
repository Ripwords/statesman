import { ulid } from 'ulid'
import { db } from '../../db/client'
import { organization, project } from '../../db/schema'
import { createProjectSchema } from '../../../shared/schemas/project'
import { chooseOrganization } from '../../utils/organization'
import { recordAuditBestEffort } from '../../services/audit'
import { requireAdmin } from '../../utils/ui-auth'

/**
 * Creates a project. This is the only way one comes into existence through the
 * application, and it is deliberately explicit: the Terraform router answers
 * 404 for an address it does not recognise (spec §9) and must keep doing so.
 * Creating on first write would turn a typo in `address` into a second, empty
 * project and split a team's state across the two with no error anywhere.
 */
export default defineEventHandler(async (event) => {
  // Before the body is read, so an anonymous caller gets 401 rather than a 400
  // about a slug it was never entitled to submit.
  const session = await requireAdmin(event)

  // A malformed slug is a 400, which is exactly what h3 raises from a validator
  // throw, so this needs no wrapping (CARRY-FORWARD §7c).
  const input = await readValidatedBody(event, createProjectSchema.parse)

  const owner = chooseOrganization(
    input.org,
    await db().select({ id: organization.id, slug: organization.slug }).from(organization)
  )

  const id = ulid()
  const inserted = await db()
    .insert(project)
    .values({ id, orgId: owner.id, name: input.project, slug: input.project })
    // The unique index is (org_id, slug). Letting it raise would surface as a
    // 500 for a request that is merely a duplicate, so the conflict is caught
    // here and answered 409.
    .onConflictDoNothing({ target: [project.orgId, project.slug] })
    // No argument: Database is a union of the node-pg and neon-http builders
    // and only the zero-argument overload is common to both. The row count is
    // what this needs, not the columns.
    .returning()

  if (inserted.length === 0) {
    throw createError({
      statusCode: 409,
      statusMessage: `${owner.slug}/${input.project} already exists`
    })
  }

  await recordAuditBestEffort({
    orgId: owner.id,
    projectId: id,
    actorType: 'user',
    actorId: session.userId,
    action: 'project.create',
    meta: { org: owner.slug, project: input.project }
  })

  return { id, org: owner.slug, slug: input.project, name: input.project }
})
