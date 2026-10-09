import type { DeclaredVariable, JsonValue } from '../../shared/schemas/variable'

export type VariableStatus = 'missing' | 'set' | 'optional' | 'undeclared'

export type StoredVariable = {
  name: string
  sensitive: boolean
  description: string | null
  /** Present only for non-sensitive rows; the service never decrypts the rest. */
  value?: JsonValue
  updatedAt: Date
  /** Who last saved it, by name; null once the account is deleted. */
  updatedByName: string | null
}

export type VariableRow = {
  name: string
  /** Null when no repository is linked or none has synced: there is nothing to compare with. */
  status: VariableStatus | null
  stored: boolean
  /**
   * The stored flag. An unstored row is `true`: the spec's default (§7), not
   * the declared block's, since Terraform's own `sensitive` defaults to false.
   */
  sensitive: boolean
  value?: JsonValue
  /** The stored description only; the panel falls back to `declared.description`. */
  description: string | null
  updatedAt: string | null
  updatedByName: string | null
  declared: DeclaredVariable | null
}

const ORDER: Record<VariableStatus, number> = { missing: 0, set: 1, optional: 1, undeclared: 1 }

/**
 * One row per name in stored ∪ declared (variables spec §8). Pure, so every
 * combination is testable without a database.
 *
 * The sensitive check is repeated here even though the service already omits
 * those values: this is the last function before a UI response, and a value
 * that reaches it by mistake must still not leave.
 */
export function mergeVariables(
  stored: StoredVariable[],
  declared: DeclaredVariable[] | null
): VariableRow[] {
  const declaredByName = new Map((declared ?? []).map((d) => [d.name, d]))
  const storedByName = new Map(stored.map((s) => [s.name, s]))
  const names = new Set([...storedByName.keys(), ...declaredByName.keys()])

  const rows = [...names].map((name): VariableRow => {
    const s = storedByName.get(name)
    const d = declaredByName.get(name) ?? null
    const status: VariableStatus | null =
      declared === null
        ? null
        : s
          ? d
            ? 'set'
            : 'undeclared'
          : d?.hasDefault
            ? 'optional'
            : 'missing'
    const row: VariableRow = {
      name,
      status,
      stored: s !== undefined,
      sensitive: s ? s.sensitive : true,
      description: s?.description || null,
      updatedAt: s ? s.updatedAt.toISOString() : null,
      updatedByName: s?.updatedByName ?? null,
      declared: d
    }
    if (s && !s.sensitive && s.value !== undefined) row.value = s.value
    return row
  })

  return rows.toSorted((a, b) => {
    const rank = (r: VariableRow) => (r.status ? ORDER[r.status] : 1)
    const byName = a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    return rank(a) - rank(b) || byName
  })
}

export type LinkSummary = {
  repoFullName: string
  ref: string
  directory: string
  lastSyncedAt: string | null
  lastSyncedSha: string | null
  lastSyncError: string | null
}
