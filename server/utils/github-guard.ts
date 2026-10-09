import { github, type GitHubClient } from '../github/client'

/** Every GitHub route 404s on a deployment without the app, after its auth guard. */
export function requireGitHub(): GitHubClient {
  const client = github()
  if (!client)
    throw createError({
      statusCode: 404,
      statusMessage: 'GitHub is not configured on this deployment.'
    })
  return client
}
