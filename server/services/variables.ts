import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/client'
import { environment, project, variable } from '../db/schema'
import { env } from '../utils/env'
import { open, seal } from '../utils/crypto'
import {
  MAX_VARIABLES_PER_ENVIRONMENT,
  variableAad,
  type JsonValue,
  type SetVariableInput
} from '../../shared/schemas/variable'
import type { StoredVariable } from '../utils/variable-status'

export type EnvironmentContext = {
  environmentId: string
  slug: string
  projectId: string
  orgId: string
}

function sealValue(environmentId: string, name: string, value: JsonValue): string {
  const plain = Buffer.from(JSON.stringify(value), 'utf8')
  return seal(env().ENCRYPTION_KEY, plain, variableAad(environmentId, name)).toString('base64')
}

/** Throws on a wrong key, tampering, or a ciphertext moved between rows (spec §4). */
function openValue(environmentId: string, name: string, sealed: string): JsonValue {
  const plain = open(
    env().ENCRYPTION_KEY,
    Buffer.from(sealed, 'base64'),
    variableAad(environmentId, name)
  )
  const parsed: JsonValue = JSON.parse(plain.toString('utf8'))
  return parsed
}

export async function environmentContext(environmentId: string): Promise<EnvironmentContext> {
  const rows = await db()
    .select({ slug: environment.slug, projectId: environment.projectId, orgId: project.orgId })
    .from(environment)
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(eq(environment.id, environmentId))
  const row = rows[0]
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Unknown environment' })
  return { environmentId, ...row }
}

export async function findEnvironment(
  projectId: string,
  slug: string
): Promise<{ id: string } | null> {
  const rows = await db()
    .select({ id: environment.id })
    .from(environment)
    .where(and(eq(environment.projectId, projectId), eq(environment.slug, slug)))
  return rows[0] ?? null
}

export async function listEnvironments(
  projectId: string
): Promise<Array<{ id: string; slug: string }>> {
  return db()
    .select({ id: environment.id, slug: environment.slug })
    .from(environment)
    .where(eq(environment.projectId, projectId))
    .orderBy(asc(environment.slug))
}

export async function createEnvironment(
  projectId: string,
  slug: string
): Promise<{ id: string; slug: string }> {
  const id = ulid()
  const inserted = await db()
    .insert(environment)
    .values({ id, projectId, slug })
    .onConflictDoNothing({ target: [environment.projectId, environment.slug] })
    .returning()
  if (inserted.length === 0) {
    throw createError({ statusCode: 409, statusMessage: `Environment ${slug} already exists` })
  }
  return { id, slug }
}

export async function deleteEnvironment(environmentId: string): Promise<void> {
  await db().delete(environment).where(eq(environment.id, environmentId))
}

async function countVariables(environmentId: string): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(variable)
    .where(eq(variable.environmentId, environmentId))
  return row?.n ?? 0
}

function tooMany(): never {
  throw createError({
    statusCode: 400,
    statusMessage: `An environment holds at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables.`
  })
}

/**
 * The limit is checked before the write rather than enforced by the database,
 * so two concurrent creates can land on 501. It is a guard against runaway
 * imports, not a quota, and that race is accepted.
 */
export async function setVariable(args: {
  environmentId: string
  name: string
  input: SetVariableInput
  userId: string
}): Promise<'created' | 'updated'> {
  const { environmentId, name, input, userId } = args
  const existing = (
    await db()
      .select({ sensitive: variable.sensitive })
      .from(variable)
      .where(and(eq(variable.environmentId, environmentId), eq(variable.name, name)))
  )[0]

  if (input.value === undefined) {
    if (!existing) {
      throw createError({ statusCode: 400, statusMessage: 'A new variable needs a value.' })
    }
    // Unticking `sensitive` on its own would turn a write-only secret into one
    // the dashboard displays — a reveal by another name (variables spec §7).
    if (existing.sensitive && !input.sensitive) {
      throw createError({
        statusCode: 400,
        statusMessage:
          'A sensitive variable can only be made non-sensitive together with a new value.'
      })
    }
    await db()
      .update(variable)
      .set({
        sensitive: input.sensitive,
        description: input.description ?? null,
        updatedBy: userId,
        updatedAt: new Date()
      })
      .where(and(eq(variable.environmentId, environmentId), eq(variable.name, name)))
    return 'updated'
  }

  if (!existing && (await countVariables(environmentId)) >= MAX_VARIABLES_PER_ENVIRONMENT) tooMany()

  const valueSealed = sealValue(environmentId, name, input.value)
  await db()
    .insert(variable)
    .values({
      id: ulid(),
      environmentId,
      name,
      valueSealed,
      sensitive: input.sensitive,
      description: input.description ?? null,
      updatedBy: userId
    })
    .onConflictDoUpdate({
      target: [variable.environmentId, variable.name],
      set: {
        valueSealed,
        sensitive: input.sensitive,
        description: input.description ?? null,
        updatedBy: userId,
        updatedAt: new Date()
      }
    })
  return existing ? 'updated' : 'created'
}

export async function deleteVariable(environmentId: string, name: string): Promise<boolean> {
  const deleted = await db()
    .delete(variable)
    .where(and(eq(variable.environmentId, environmentId), eq(variable.name, name)))
    .returning()
  return deleted.length > 0
}

/** The only function that decrypts sensitive values. Its one caller is the token door. */
export async function readDeliveryValues(
  environmentId: string
): Promise<Record<string, JsonValue>> {
  const rows = await db()
    .select({ name: variable.name, valueSealed: variable.valueSealed })
    .from(variable)
    .where(eq(variable.environmentId, environmentId))
    .orderBy(asc(variable.name))
  return Object.fromEntries(
    rows.map((r) => [r.name, openValue(environmentId, r.name, r.valueSealed)])
  )
}

export async function listStoredForUi(environmentId: string): Promise<StoredVariable[]> {
  const rows = await db()
    .select()
    .from(variable)
    .where(eq(variable.environmentId, environmentId))
    .orderBy(asc(variable.name))
  return rows.map((r) => {
    const base: StoredVariable = {
      name: r.name,
      sensitive: r.sensitive,
      description: r.description,
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy
    }
    return r.sensitive ? base : { ...base, value: openValue(environmentId, r.name, r.valueSealed) }
  })
}

/**
 * One multi-row upsert, so an import lands whole or not at all without a
 * transaction (Neon HTTP has none). Everything imported is sensitive: a file
 * of variables is assumed to hold secrets until someone says otherwise.
 */
export async function importValues(args: {
  environmentId: string
  values: Record<string, JsonValue>
  userId: string
  dryRun: boolean
}): Promise<{ created: string[]; overwritten: string[] }> {
  const { environmentId, values, userId, dryRun } = args
  const names = Object.keys(values).toSorted()
  if (names.length === 0) return { created: [], overwritten: [] }

  const existingRows = await db()
    .select({ name: variable.name })
    .from(variable)
    .where(and(eq(variable.environmentId, environmentId), inArray(variable.name, names)))
  const existing = new Set(existingRows.map((r) => r.name))
  const created = names.filter((n) => !existing.has(n))
  const overwritten = names.filter((n) => existing.has(n))

  if ((await countVariables(environmentId)) + created.length > MAX_VARIABLES_PER_ENVIRONMENT)
    tooMany()
  if (dryRun) return { created, overwritten }

  const now = new Date()
  await db()
    .insert(variable)
    .values(
      names.map((name) => ({
        id: ulid(),
        environmentId,
        name,
        valueSealed: sealValue(environmentId, name, values[name] ?? null),
        sensitive: true,
        updatedBy: userId,
        updatedAt: now
      }))
    )
    .onConflictDoUpdate({
      target: [variable.environmentId, variable.name],
      set: {
        valueSealed: sql`excluded.value_sealed`,
        sensitive: true,
        updatedBy: userId,
        updatedAt: now
      }
    })
  return { created, overwritten }
}
