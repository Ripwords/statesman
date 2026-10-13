import { toTfvars } from '../../shared/hcl/tfvars'
import type { JsonValue } from '../../shared/schemas/variable'
import type { BackendSettings } from '../../shared/schemas/backend'

function sorted<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(map).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  )
}

export function renderVars(values: Record<string, JsonValue>, fileName: string): string {
  const ordered = sorted(values)
  if (fileName.endsWith('.tfvars.json')) return JSON.stringify(ordered, null, 2) + '\n'
  return toTfvars(ordered)
}

export function renderBackend(backend: BackendSettings): string {
  return toTfvars(sorted(backend))
}
