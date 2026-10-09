import type { JsonValue } from '~~/shared/schemas/variable'

/**
 * String mode sends the text exactly as typed. "3" stays the string "3": a
 * Terraform `string` variable given a number would be converted anyway, but a
 * value that looks like JSON is not JSON just because it parses.
 */
export function parseEditorValue(
  text: string,
  mode: 'string' | 'json'
): { ok: true; value: JsonValue } | { ok: false; error: string } {
  if (mode === 'string') return { ok: true, value: text }
  try {
    const value: JsonValue = JSON.parse(text)
    return { ok: true, value }
  } catch {
    return { ok: false, error: 'Not valid JSON. Strings need double quotes in JSON mode.' }
  }
}

export function formatValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}
