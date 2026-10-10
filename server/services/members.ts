import { and, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/client'
import { project, projectMember, user } from '../db/schema'
import { projectRoleSchema, type ProjectRole } from '../../shared/schemas/project-role'
import { recordAuditBestEffort } from './audit'
import { ensureAccessRecord, NOT_FOUND } from '../utils/project-access'

export type MemberRow = {
  userId: string
  name: string
  email: string
  role: ProjectRole
  addedAt: Date
}

async function projectOf(projectId: string): Promise<{ orgId: string; name: string }> {
  const rows = await db()
    .select({ orgId: project.orgId, name: project.name })
    .from(project)
    .where(eq(project.id, projectId))
  const row = rows[0]
  if (!row) throw createError({ statusCode: 404, statusMessage: NOT_FOUND })
  return row
}

async function orgIdOf(projectId: string): Promise<string> {
  return (await projectOf(projectId)).orgId
}

export async function listMembers(projectId: string): Promise<MemberRow[]> {
  const rows = await db()
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: projectMember.role,
      addedAt: projectMember.createdAt
    })
    .from(projectMember)
    .innerJoin(user, eq(projectMember.userId, user.id))
    .where(eq(projectMember.organizationId, projectId))
    .orderBy(user.name)
  // A role string the schema does not recognise is not a member (least privilege).
  return rows.flatMap((r) => {
    const role = projectRoleSchema.safeParse(r.role)
    return role.success ? [{ ...r, role: role.data }] : []
  })
}

export async function addMember(input: {
  projectId: string
  email: string
  role: ProjectRole
  actorId: string
}): Promise<{ userId: string }> {
  const { orgId, name: projectName } = await projectOf(input.projectId)
  const rows = await db()
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(eq(sql`lower(${user.email})`, input.email.toLowerCase()))
  const target = rows[0]
  if (!target)
    throw createError({
      statusCode: 404,
      statusMessage: 'No account with that email. An admin creates accounts on the Users page.'
    })

  await ensureAccessRecord(input.projectId, projectName)

  const inserted = await db()
    .insert(projectMember)
    .values({ id: ulid(), organizationId: input.projectId, userId: target.id, role: input.role })
    .onConflictDoNothing({ target: [projectMember.organizationId, projectMember.userId] })
    .returning()
  if (inserted.length === 0) {
    const [existing] = await db()
      .select({ role: projectMember.role })
      .from(projectMember)
      .where(
        and(eq(projectMember.organizationId, input.projectId), eq(projectMember.userId, target.id))
      )
    throw createError({
      statusCode: 409,
      statusMessage: `${input.email} is already a ${existing?.role ?? 'member'} on this project.`
    })
  }
  await recordAuditBestEffort({
    orgId,
    projectId: input.projectId,
    actorType: 'user',
    actorId: input.actorId,
    action: 'member.add',
    meta: { userId: target.id, role: input.role }
  })
  return { userId: target.id }
}

export async function changeMemberRole(input: {
  projectId: string
  userId: string
  role: ProjectRole
  actorId: string
}): Promise<void> {
  const orgId = await orgIdOf(input.projectId)
  const before = await db()
    .select({ role: projectMember.role })
    .from(projectMember)
    .where(
      and(eq(projectMember.organizationId, input.projectId), eq(projectMember.userId, input.userId))
    )
  if (!before[0])
    throw createError({
      statusCode: 404,
      statusMessage: 'That account is not a member of this project.'
    })
  const updated = await db()
    .update(projectMember)
    .set({ role: input.role })
    .where(
      and(eq(projectMember.organizationId, input.projectId), eq(projectMember.userId, input.userId))
    )
    .returning()
  if (updated.length === 0)
    throw createError({
      statusCode: 404,
      statusMessage: 'That account is not a member of this project.'
    })
  await recordAuditBestEffort({
    orgId,
    projectId: input.projectId,
    actorType: 'user',
    actorId: input.actorId,
    action: 'member.role',
    meta: { userId: input.userId, from: before[0].role, to: input.role }
  })
}

export async function removeMember(input: {
  projectId: string
  userId: string
  actorId: string
}): Promise<void> {
  const orgId = await orgIdOf(input.projectId)
  const removed = await db()
    .delete(projectMember)
    .where(
      and(eq(projectMember.organizationId, input.projectId), eq(projectMember.userId, input.userId))
    )
    .returning()
  if (!removed[0])
    throw createError({
      statusCode: 404,
      statusMessage: 'That account is not a member of this project.'
    })
  await recordAuditBestEffort({
    orgId,
    projectId: input.projectId,
    actorType: 'user',
    actorId: input.actorId,
    action: 'member.remove',
    meta: { userId: input.userId, role: removed[0].role }
  })
}
