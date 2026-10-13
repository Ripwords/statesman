const VAR_FILE_COMMANDS = ['plan', 'apply', 'destroy', 'import', 'refresh', 'console'] as const

/** Every key the CLI may write. A key here but not in this run's list is removed. */
const ALL_OWNED = [
  'TF_DATA_DIR',
  'TF_CLI_ARGS_init',
  ...VAR_FILE_COMMANDS.map((c) => `TF_CLI_ARGS_${c}`)
]

const HEADER =
  '# TF_DATA_DIR and TF_CLI_ARGS_* are written by `statesman pull`. Other lines are yours and are kept.'

const LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

export function ownedEntries(
  files: { vars: string; backend?: string },
  env: string
): Array<[string, string]> {
  const entries: Array<[string, string]> = [['TF_DATA_DIR', `.terraform-${env}`]]
  if (files.backend) entries.push(['TF_CLI_ARGS_init', `-backend-config=${files.backend}`])
  for (const c of VAR_FILE_COMMANDS) entries.push([`TF_CLI_ARGS_${c}`, `-var-file=${files.vars}`])
  return entries
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1)
  return v
}

export function mergeEnvFile(existing: string | null, owned: Array<[string, string]>): string {
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n'
  const wanted = new Map(owned)
  const written = new Set<string>()
  const lines = existing === null ? [HEADER] : existing.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const out: string[] = []
  for (const line of lines) {
    const m = LINE.exec(line)
    const key = m?.[2]
    if (!m || key === undefined || !ALL_OWNED.includes(key)) {
      out.push(line)
      continue
    }
    const value = wanted.get(key)
    if (value === undefined || written.has(key)) continue // no longer owned here, or a duplicate
    out.push(`${m[1] ?? ''}${key}=${value}`)
    written.add(key)
  }
  for (const [key, value] of owned) if (!written.has(key)) out.push(`${key}=${value}`)
  return out.join(eol) + eol
}

export function envFileDiffers(existing: string, owned: Array<[string, string]>): string[] {
  const found = new Map<string, string>()
  for (const line of existing.split(/\r?\n/)) {
    const m = LINE.exec(line)
    if (m?.[2] && ALL_OWNED.includes(m[2])) found.set(m[2], unquote(m[3] ?? ''))
  }
  const wanted = new Map(owned)
  const differing = owned.filter(([k, v]) => found.get(k) !== v).map(([k]) => k)
  const extra = [...found.keys()].filter((k) => !wanted.has(k))
  return [...differing, ...extra]
}
