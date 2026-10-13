import { z } from 'zod'
import { backendSettingsSchema, type CheckoutResponse } from '../../shared/schemas/backend'
import { variableValueSchema } from '../../shared/schemas/variable'
import { CliError } from './errors'

const responseSchema = z.object({
  variables: z.record(z.string(), variableValueSchema),
  backend: backendSettingsSchema.nullable()
})

export async function fetchCheckout(args: {
  server: string
  project: string
  env: string
  token: string
  fetchImpl?: typeof fetch
}): Promise<CheckoutResponse> {
  const { server, project, env, token, fetchImpl = fetch } = args
  const url = new URL(`/api/checkout/${project}/${env}`, server).toString()
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` }
    })
  } catch {
    throw new CliError(`could not reach statesman at ${server}`, 2)
  }
  if (response.status === 401)
    throw new CliError('statesman rejected STATESMAN_TOKEN (expired, revoked or mistyped)', 2)
  if (response.status === 403)
    throw new CliError(`this token cannot read variables of ${project}`, 2)
  if (response.status === 404) {
    throw new CliError(
      `environment "${env}" does not exist in ${project}; create it on the Variables tab`,
      2
    )
  }
  if (!response.ok)
    throw new CliError(`statesman answered ${response.status} for ${project}/${env}`, 2)
  const parsed = responseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success)
    throw new CliError(`statesman sent an unexpected response for ${project}/${env}`, 2)
  return parsed.data
}
