/* eslint-disable no-console -- this file is the terminal output of the CLI */
import { parseArgs } from 'node:util'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CliError } from './errors'
import { pull, status, type CommandResult } from './commands'
import { formatJson, formatText } from './output'

const USAGE = `usage:
  statesman status [--env <slug>]... [--dir <path>] [--json]
  statesman pull   [--env <slug>]... [--dir <path>] [--force] [--json]

STATESMAN_TOKEN  a token with Read Variables for the manifest's project (required)
STATESMAN_URL    overrides "server" in statesman.json`

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        env: { type: 'string', multiple: true, default: [] },
        dir: { type: 'string', default: '.' },
        force: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false }
      }
    })
    const command = positionals[0]
    if (values.help || command === 'help') {
      console.log(USAGE)
      return 0
    }
    const opts = {
      dir: resolve(values.dir),
      envs: values.env,
      token: env.STATESMAN_TOKEN || undefined,
      serverOverride: env.STATESMAN_URL || undefined
    }
    let result: CommandResult
    if (command === 'status') result = await status(opts)
    else if (command === 'pull') result = await pull({ ...opts, force: values.force })
    else throw new CliError(`unknown command ${command ?? '(none)'}\n${USAGE}`, 2)
    console.log(values.json ? formatJson(result) : formatText(result))
    return result.exitCode
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`statesman: ${error.message}`)
      return error.exitCode
    }
    if (
      error instanceof TypeError &&
      'code' in error &&
      String(error.code).startsWith('ERR_PARSE_ARGS')
    ) {
      console.error(`statesman: ${error.message}\n${USAGE}`)
      return 2
    }
    // An unexpected defect: name its type only, so no value can leak through a message.
    console.error(`statesman: unexpected ${error instanceof Error ? error.name : 'error'}`)
    return 2
  }
}

/** True when this module is the entry point, also when started through a symlink. */
export function isDirectRun(argv1: string | undefined, metaUrl: string): boolean {
  if (!argv1) return false
  try {
    return pathToFileURL(realpathSync(argv1)).href === metaUrl
  } catch {
    return false
  }
}

// Run when executed directly (bundled or via tsx), not when imported by tests.
if (isDirectRun(process.argv[1], import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env)
}
