import { requireSession } from '../../utils/ui-auth'
import { github } from '../../github/client'
import { listInstallations } from '../../services/sync'

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const configured = github() !== null
  return {
    configured,
    installUrl: configured ? '/api/github/install' : null,
    installations: configured ? await listInstallations() : []
  }
})
