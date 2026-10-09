import type { LocationQuery } from 'vue-router'

export type GitHubNotice = {
  title: string
  description: string
  color: 'success' | 'info'
  icon: string
}

/** What `/api/github/setup` meant by the `?github=` it redirected to; null for anything else. */
export function githubNotice(query: LocationQuery): GitHubNotice | null {
  if (query.github === 'connected')
    return {
      title: 'GitHub Connected',
      description: 'Link a repository from a project’s Variables tab.',
      color: 'success',
      icon: 'i-lucide-github'
    }
  if (query.github === 'requested')
    return {
      title: 'Installation Requested',
      description:
        'An owner of the GitHub organisation has to approve it. Once they do, the Variables tab offers Link repository.',
      color: 'info',
      icon: 'i-lucide-clock'
    }
  return null
}
