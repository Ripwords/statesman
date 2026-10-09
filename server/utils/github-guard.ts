import { github, GitHubError, type GitHubClient } from '../github/client'
import { env, type GitHubAppConfig } from './env'
import { listInstallations } from '../services/sync'

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

/** The app's own config, for the routes that need its slug; 404s like `requireGitHub`. */
export function requireGitHubApp(): GitHubAppConfig {
  requireGitHub()
  const app = env().GITHUB_APP
  if (!app)
    throw createError({
      statusCode: 404,
      statusMessage: 'GitHub is not configured on this deployment.'
    })
  return app
}

/** An installation id from a request must be one this deployment recorded. */
export async function requireInstallation(installationId: number): Promise<void> {
  const known = (await listInstallations()).some((i) => i.installationId === installationId)
  if (!known) throw createError({ statusCode: 404, statusMessage: 'Unknown installation.' })
}

/**
 * Runs a GitHub call and turns its failures into fixed, readable answers. The
 * raw GitHub text can carry request detail, so it never reaches the caller.
 */
export async function viaGitHub<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error
    if (error.status === 404)
      throw createError({
        statusCode: 404,
        statusMessage: 'GitHub could not find that installation or repository.'
      })
    if (error.status === 403)
      throw createError({
        statusCode: 403,
        statusMessage: 'GitHub refused access. Check the app permissions and installation.'
      })
    throw createError({ statusCode: 502, statusMessage: 'GitHub returned an error. Try again.' })
  }
}
