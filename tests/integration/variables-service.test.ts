import { isApiError } from './../ui/nitro-globals'
import { describe, it, expect, beforeEach } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { environment, variable } from '../../server/db/schema'
import { resetDb, seedProject, seedUser } from '../protocol/helpers'
import {
  createEnvironment,
  setVariable,
  deleteVariable,
  readDeliveryValues,
  listStoredForUi,
  importValues,
  listEnvironments,
  findEnvironment
} from '../../server/services/variables'

const ORG = 'vars-service'
let envId: string
let userId: string

beforeEach(async () => {
  await resetDb(ORG)
  const projectId = await seedProject(ORG, 'p')
  envId = (await createEnvironment(projectId, 'dev')).id
  userId = await seedUser('vars-service-user')
})

const set = (name: string, input: Parameters<typeof setVariable>[0]['input']) =>
  setVariable({ environmentId: envId, name, input, userId })

describe('environments', () => {
  it('refuses a duplicate slug with 409', async () => {
    const projectId = await seedProject(ORG, 'q')
    await createEnvironment(projectId, 'dev')
    await expect(createEnvironment(projectId, 'dev')).rejects.toMatchObject({ statusCode: 409 })
  })
  it('lists by slug and finds by slug', async () => {
    const projectId = await seedProject(ORG, 'r')
    await createEnvironment(projectId, 'prod')
    await createEnvironment(projectId, 'dev')
    expect((await listEnvironments(projectId)).map((e) => e.slug)).toEqual(['dev', 'prod'])
    expect(await findEnvironment(projectId, 'prod')).not.toBeNull()
    expect(await findEnvironment(projectId, 'nope')).toBeNull()
  })
})

describe('setVariable', () => {
  it('creates, then updates, and delivers the latest value', async () => {
    expect(await set('a', { value: 'one', sensitive: true })).toBe('created')
    expect(await set('a', { value: 'two', sensitive: true })).toBe('updated')
    expect(await readDeliveryValues(envId)).toEqual({ a: 'two' })
  })

  it.each(['3', 'true', 'null', '[1]', '{"a":1}'])('keeps the string %j a string', async (s) => {
    await set('s', { value: s, sensitive: false })
    expect((await readDeliveryValues(envId)).s).toBe(s)
  })

  it('round-trips structured values', async () => {
    await set('tags', { value: { team: 'core', ids: [1, 2] }, sensitive: false })
    expect((await readDeliveryValues(envId)).tags).toEqual({ team: 'core', ids: [1, 2] })
  })

  it('refuses a new variable without a value', async () => {
    await expect(set('new', { sensitive: true })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('keeps the stored value when a sensitive edit omits it', async () => {
    await set('pw', { value: 'hunter2', sensitive: true })
    await set('pw', { sensitive: true, description: 'db password' })
    expect((await readDeliveryValues(envId)).pw).toBe('hunter2')
    const [row] = await listStoredForUi(envId)
    expect(row?.description).toBe('db password')
  })

  it('refuses to make a sensitive variable non-sensitive without a new value', async () => {
    await set('pw', { value: 'hunter2', sensitive: true })
    await expect(set('pw', { sensitive: false })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('allows making it non-sensitive together with a new value', async () => {
    await set('pw', { value: 'hunter2', sensitive: true })
    await set('pw', { value: 'public', sensitive: false })
    const [row] = await listStoredForUi(envId)
    expect(row?.value).toBe('public')
  })

  it('refuses the 501st variable', async () => {
    await importValues({
      environmentId: envId,
      userId,
      dryRun: false,
      values: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`v${i}`, i]))
    })
    await expect(set('one_more', { value: 1, sensitive: false })).rejects.toMatchObject({
      statusCode: 400
    })
  })
})

describe('listStoredForUi', () => {
  it('omits sensitive values and includes non-sensitive ones', async () => {
    await set('secret', { value: 'hunter2', sensitive: true })
    await set('region', { value: 'eu-west-1', sensitive: false })
    const rows = await listStoredForUi(envId)
    const secret = rows.find((r) => r.name === 'secret')
    expect(secret).not.toHaveProperty('value')
    expect(rows.find((r) => r.name === 'region')?.value).toBe('eu-west-1')
  })
})

describe('sealing', () => {
  it('stores no plaintext', async () => {
    await set('pw', { value: 'plaintext-canary', sensitive: true })
    const [row] = await db().select().from(variable).where(eq(variable.environmentId, envId))
    expect(row?.valueSealed).not.toContain('plaintext-canary')
    expect(Buffer.from(row?.valueSealed ?? '', 'base64').toString('utf8')).not.toContain(
      'plaintext-canary'
    )
  })

  it('fails loudly when ciphertext is moved to another row', async () => {
    await set('a', { value: 'for-a', sensitive: true })
    await set('b', { value: 'for-b', sensitive: true })
    const rows = await db().select().from(variable).where(eq(variable.environmentId, envId))
    const a = rows.find((r) => r.name === 'a')
    await db()
      .update(variable)
      .set({ valueSealed: a?.valueSealed ?? '' })
      .where(and(eq(variable.environmentId, envId), eq(variable.name, 'b')))
    await expect(readDeliveryValues(envId)).rejects.toThrow()
  })
})

describe('deleteVariable', () => {
  it('reports whether a row went', async () => {
    await set('a', { value: 1, sensitive: false })
    expect(await deleteVariable(envId, 'a')).toBe(true)
    expect(await deleteVariable(envId, 'a')).toBe(false)
  })
})

describe('importValues', () => {
  it('previews without writing', async () => {
    await set('a', { value: 1, sensitive: false })
    const preview = await importValues({
      environmentId: envId,
      userId,
      dryRun: true,
      values: { a: 2, b: 3 }
    })
    expect(preview).toEqual({ created: ['b'], overwritten: ['a'] })
    expect(await readDeliveryValues(envId)).toEqual({ a: 1 })
  })

  it('writes and marks every imported variable sensitive', async () => {
    await set('a', { value: 1, sensitive: false })
    await importValues({ environmentId: envId, userId, dryRun: false, values: { a: 2, b: 3 } })
    expect(await readDeliveryValues(envId)).toEqual({ a: 2, b: 3 })
    expect((await listStoredForUi(envId)).every((r) => r.sensitive)).toBe(true)
  })

  it('refuses an import that would pass 500 in total', async () => {
    await set('existing', { value: 1, sensitive: false })
    const values = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`v${i}`, i]))
    await expect(
      importValues({ environmentId: envId, userId, dryRun: false, values })
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('plaintext canary', () => {
  it('keeps imported values sealed in the database', async () => {
    await importValues({
      environmentId: envId,
      userId,
      dryRun: false,
      values: { k: 'import-canary' }
    })
    const rows = await db().select().from(variable).where(eq(variable.environmentId, envId))
    expect(JSON.stringify(rows)).not.toContain('import-canary')
  })

  it('does not echo a refused value in the error', async () => {
    await set('pw', { value: 'error-canary', sensitive: true })
    const err = await set('pw', { sensitive: false }).catch((e: unknown) => e)
    expect(isApiError(err)).toBe(true)
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('error-canary')
  })
})

describe('downgrade race and cross-environment ciphertext', () => {
  it('refuses a metadata-only downgrade of a row that has become sensitive', async () => {
    await set('pw', { value: 'v', sensitive: false })
    await db()
      .update(variable)
      .set({ sensitive: true })
      .where(and(eq(variable.environmentId, envId), eq(variable.name, 'pw')))
    await expect(set('pw', { sensitive: false })).rejects.toMatchObject({ statusCode: 400 })
    const [row] = await db().select().from(variable).where(eq(variable.environmentId, envId))
    expect(row?.sensitive).toBe(true)
  })

  it('refuses to open a sealed value copied from another environment', async () => {
    await set('a', { value: 'env-a-secret', sensitive: true })
    const [src] = await db().select().from(variable).where(eq(variable.environmentId, envId))
    const [projectRow] = await db()
      .select({ projectId: environment.projectId })
      .from(environment)
      .where(eq(environment.id, envId))
    const other = await createEnvironment(projectRow?.projectId ?? '', 'staging')
    await db()
      .insert(variable)
      .values({
        id: 'copied-row',
        environmentId: other.id,
        name: 'a',
        valueSealed: src?.valueSealed ?? '',
        sensitive: false
      })
    await expect(readDeliveryValues(other.id)).rejects.toThrow()
    await expect(listStoredForUi(other.id)).rejects.toThrow()
  })
})
