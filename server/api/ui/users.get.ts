import { listAccounts } from '../../services/users'
import { requireAdmin } from '../../utils/ui-auth'

/**
 * The account list. Admin-only — not because the names are secret, but because
 * this is the screen the role and password controls hang off, and a member has
 * nothing to do here.
 */
export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return listAccounts()
})
