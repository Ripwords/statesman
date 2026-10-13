import { isDeepStrictEqual } from 'node:util'
import { HclError, type HclToolkit } from '../../server/hcl/toolkit'
import type { JsonValue } from '../../shared/schemas/variable'

export class LocalParseError extends Error {
  override name = 'LocalParseError'
}

export type MapDiff = { onlyInStatesman: string[]; onlyLocal: string[]; changed: string[] }

/** Throws LocalParseError. Messages carry a file and line, never a value. */
export function parseLocal(
  text: string,
  fileName: string,
  hcl: HclToolkit
): Record<string, JsonValue> {
  if (fileName.endsWith('.json')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new LocalParseError(`${fileName}: not valid JSON`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LocalParseError(`${fileName}: must be a JSON object`)
    }
    return parsed as Record<string, JsonValue>
  }
  try {
    return hcl.parseTfvars(text)
  } catch (error) {
    if (error instanceof HclError) {
      // HclError's message is "<file>:<line>: <reason>" with the toolkit's own
      // placeholder file name. Strip that exact prefix by length and restate it.
      const prefix = `${error.file}:${error.line}: `
      const reason = error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : error.message
      throw new LocalParseError(`${fileName}:${error.line}: ${reason}`)
    }
    throw error
  }
}

export function diffMaps(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>
): MapDiff {
  const onlyInStatesman = Object.keys(expected)
    .filter((k) => !Object.hasOwn(actual, k))
    .toSorted()
  const onlyLocal = Object.keys(actual)
    .filter((k) => !Object.hasOwn(expected, k))
    .toSorted()
  const changed = Object.keys(expected)
    .filter((k) => Object.hasOwn(actual, k) && !isDeepStrictEqual(expected[k], actual[k]))
    .toSorted()
  return { onlyInStatesman, onlyLocal, changed }
}

export function isEmptyDiff(d: MapDiff): boolean {
  return d.onlyInStatesman.length === 0 && d.onlyLocal.length === 0 && d.changed.length === 0
}

/** Variable names only, never values. */
export function describeDiff(d: MapDiff): string[] {
  return [
    ...d.changed,
    ...d.onlyInStatesman.map((n) => `+${n}`),
    ...d.onlyLocal.map((n) => `-${n}`)
  ]
}
