import { randomBytes } from 'node:crypto'
import { requireAdmin } from '../../utils/ui-auth'
import { requireGitHub } from '../../utils/github-guard'
import { env } from '../../utils/env'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  requireGitHub()
  const state = randomBytes(24).toString('base64url')
  setCookie(event, 'statesman_gh_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().BETTER_AUTH_URL.startsWith('https://'),
    path: '/api/github',
    maxAge: 600
  })
  const slug = env().GITHUB_APP?.slug ?? ''
  return sendRedirect(event, `https://github.com/apps/${slug}/installations/new?state=${state}`)
})
