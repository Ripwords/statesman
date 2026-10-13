import type { CommandResult, Reported } from './commands'

function describe(r: Reported): string {
  if (r.action === 'written')
    return r.state === 'missing'
      ? 'written'
      : `updated${r.detail.length ? `: ${r.detail.join(', ')}` : ''}`
  if (r.action === 'refused')
    return `refused, differs: ${r.detail.join(', ')} (use --force after checking)`
  switch (r.state) {
    case 'ok':
      return 'ok'
    case 'missing':
      return 'missing'
    case 'differs':
      return `differs: ${r.detail.join(', ')}`
    case 'unreadable':
      return `unreadable: ${r.detail[0] ?? ''}`
    case 'stray':
      return `stray: environment "${r.detail[0] ?? ''}" not in statesman.json`
    case 'no-backend':
      return 'no backend settings in statesman'
  }
}

export function formatText(result: CommandResult): string {
  const envWidth = Math.max(0, ...result.reports.map((r) => (r.env ?? '').length))
  const fileWidth = Math.max(0, ...result.reports.map((r) => r.file.length))
  return result.reports
    .map((r) => `${(r.env ?? '').padEnd(envWidth)}  ${r.file.padEnd(fileWidth)}  ${describe(r)}`)
    .join('\n')
}

/** `desired` holds secrets, so it is never part of the JSON report. */
export function formatJson(result: CommandResult): string {
  return JSON.stringify(
    {
      exitCode: result.exitCode,
      files: result.reports.map(({ env, file, kind, state, detail, action }) => ({
        env,
        file,
        kind,
        state,
        detail,
        action: action ?? null
      }))
    },
    null,
    2
  )
}
