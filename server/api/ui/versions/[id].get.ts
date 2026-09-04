import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../db/client'
import { stateVersion } from '../../../db/schema'
import { store } from '../../../storage'
import { open } from '../../../utils/crypto'
import { env } from '../../../utils/env'
import { requireSession } from '../../../utils/ui-auth'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

/**
 * Decrypts one stored version for the diff view. State is an opaque Terraform
 * document (spec §12), so it is parsed opportunistically and handed back raw
 * when it is not JSON rather than being rejected.
 */
export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)

  const rows = await db()
    .select({ blobKey: stateVersion.blobKey })
    .from(stateVersion)
    .where(eq(stateVersion.id, id))
  const key = rows[0]?.blobKey
  if (!key) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Unknown version. It may have been removed by retention.'
    })
  }

  const sealed = await store().get(key)
  if (!sealed) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Stored state for this version is missing and cannot be shown.'
    })
  }

  const plain = open(env().ENCRYPTION_KEY, sealed).toString('utf8')
  try {
    return { json: JSON.parse(plain) as unknown, raw: null }
  } catch {
    return { json: null, raw: plain }
  }
})
