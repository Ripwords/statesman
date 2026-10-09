export function linkDescription(link: {
  repoFullName: string
  ref: string
  directory: string
}): string {
  return `${link.repoFullName} · ${link.ref} · /${link.directory}`
}

/** The link itself was saved before the sync ran, so a failed first sync is not a failed link. */
export function firstSyncFailure(error: string): string {
  return `Linked. The first sync failed: ${error}`
}
