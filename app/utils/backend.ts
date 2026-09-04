export type BackendSnippetInput = {
  /** Origin of this server, as the client will actually reach it. */
  origin: string
  org: string
  project: string
  /**
   * Included as a `password` line when given. Omitted otherwise, because a
   * token pasted into a committed .tf file is a token in version control —
   * `TF_HTTP_PASSWORD` is the alternative the surrounding copy points at.
   */
  password?: string
}

/**
 * The backend block for one project, in the exact shape spec §2 documents.
 *
 * Written once and shared by the token reveal and the project reveal: two
 * copies of this string would drift, and the failure mode of a drifted
 * `lock_method` is an apply that 405s in the field rather than anything a test
 * here would catch.
 */
export function backendSnippet(input: BackendSnippetInput): string {
  const address = `${input.origin}/api/tf/${input.org}/${input.project}`
  const lines = [
    'terraform {',
    '  backend "http" {',
    `    address        = "${address}"`,
    `    lock_address   = "${address}/lock"`,
    `    unlock_address = "${address}/lock"`,
    // POST/DELETE rather than the backend's LOCK/UNLOCK defaults: those are
    // WebDAV-inherited verbs and no platform documents whether its edge
    // forwards them (spec §2).
    '    lock_method    = "POST"',
    '    unlock_method  = "DELETE"',
    // Ignored by the server; Terraform requires a value in the field.
    '    username       = "statesman"'
  ]
  if (input.password !== undefined) lines.push(`    password       = "${input.password}"`)
  lines.push('  }', '}')
  return lines.join('\n')
}
