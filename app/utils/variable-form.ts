import type { VariableRow } from '~~/server/utils/variable-status'
import type { JsonValue } from '~~/shared/schemas/variable'
import { formatValue, type parseEditorValue } from './variable-value'

export type VariableForm = {
  name: string
  description: string
  sensitive: boolean
  jsonMode: boolean
  valueText: string
  /** A sensitive value is stored, so an empty value field means "keep it". */
  keepsSecret: boolean
}

/** What the edit modal starts from. Pure, so the defaults are testable without mounting it. */
export function seedVariableForm(row: VariableRow | null): VariableForm {
  const shown = row && !row.sensitive && row.value !== undefined ? row.value : undefined
  return {
    name: row?.name ?? '',
    description: row?.description ?? '',
    sensitive: row?.stored ? row.sensitive : true,
    jsonMode: shown !== undefined && typeof shown !== 'string',
    valueText: shown === undefined ? '' : formatValue(shown),
    keepsSecret: row?.stored === true && row.sensitive
  }
}

/** `description` is always sent: the route treats an omitted one as "clear". */
export function variablePutBody(
  form: Pick<VariableForm, 'sensitive'>,
  value: ReturnType<typeof parseEditorValue> | null,
  description: string | null | undefined
): { value?: JsonValue; sensitive: boolean; description: string | null } {
  return {
    ...(value?.ok ? { value: value.value } : {}),
    sensitive: form.sensitive,
    description: description ? description : null
  }
}

/** The stored description, or the one the repository declares when none is stored (spec §8). */
export function shownDescription(row: VariableRow): string | null {
  return row.description || row.declared?.description || null
}
