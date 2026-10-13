import type { Manifest } from '../../shared/schemas/manifest'

const SLUG = '[a-z0-9][a-z0-9-]*'
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function matcher(pattern: string): RegExp | null {
  if (!pattern.includes('{env}')) return null
  const source = pattern.split('{env}').map(escape).join(`(${SLUG})`)
  return new RegExp(`^${source}$`)
}

/** Files that look like a checkout for an environment the manifest does not list. */
export function findStrays(
  entries: string[],
  tracked: Set<string>,
  manifest: Manifest
): Array<{ file: string; env: string }> {
  const listed = new Set(manifest.environments)
  const matchers = [manifest.files.vars, manifest.files.backend, manifest.files.env]
    .filter((p): p is string => p !== undefined)
    .map(matcher)
    .filter((m): m is RegExp => m !== null)
  const strays: Array<{ file: string; env: string }> = []
  for (const file of entries.toSorted()) {
    if (tracked.has(file)) continue
    for (const m of matchers) {
      const env = m.exec(file)?.[1]
      if (env !== undefined && !listed.has(env)) {
        strays.push({ file, env })
        break
      }
    }
  }
  return strays
}
