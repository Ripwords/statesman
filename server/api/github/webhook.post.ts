import { requireGitHub } from '../../utils/github-guard'
import { env } from '../../utils/env'
import { deploymentOrgId } from '../../utils/deployment-org'
import { handleWebhook } from '../../github/webhook'
import { recordAuditBestEffort } from '../../services/audit'
import { hcl } from '../../hcl'

/** Called by GitHub, not a browser: no session. The HMAC over the raw body is the only credential. */
export default defineEventHandler(async (event) => {
  const client = requireGitHub()
  const rawBody = (await readRawBody(event, false)) ?? Buffer.alloc(0)
  const result = await handleWebhook(
    {
      event: getRequestHeader(event, 'x-github-event'),
      signature: getRequestHeader(event, 'x-hub-signature-256'),
      rawBody
    },
    {
      secret: env().GITHUB_APP?.webhookSecret ?? '',
      sync: { client, hcl: await hcl() },
      // The uninstall is already committed; failing to find the org must not turn it into a 500 GitHub retries.
      audit: async () => {
        try {
          await recordAuditBestEffort({
            orgId: await deploymentOrgId(),
            actorType: 'user',
            action: 'github.uninstall'
          })
        } catch (error) {
          console.error('Could not audit the GitHub uninstall', error)
        }
      }
    }
  )
  setResponseStatus(event, result.status)
  return { synced: result.synced.length }
})
