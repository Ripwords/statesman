import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CliError } from './errors'

const run = promisify(execFile)
const env = { ...process.env, LC_ALL: 'C' }

type GitFailure = { code?: unknown; stderr?: unknown }

/**
 * false when `dir` is not in a git work tree (or git is not installed).
 * Any other git failure stops the run: the ignore check could not be made.
 */
async function inWorkTree(dir: string): Promise<boolean> {
  try {
    await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, env })
    return true
  } catch (error) {
    const { code, stderr } = error as GitFailure
    if (code === 'ENOENT') return false
    if (code === 128 && /not a git repository/i.test(String(stderr))) return false
    throw new CliError(`git failed (exit ${String(code)}); fix the repository and retry`, 2)
  }
}

/** null when `dir` is not inside a git work tree. */
export async function gitIgnored(dir: string, file: string): Promise<boolean | null> {
  if (!(await inWorkTree(dir))) return null
  try {
    await run('git', ['check-ignore', '-q', '--', file], { cwd: dir, env })
    return true
  } catch (error) {
    const { code } = error as GitFailure
    if (code === 1) return false
    throw new CliError(`git check-ignore failed (exit ${String(code)})`, 2)
  }
}

export async function gitTracked(dir: string): Promise<Set<string>> {
  if (!(await inWorkTree(dir))) return new Set()
  try {
    const { stdout } = await run('git', ['ls-files', '-z', '--', '.'], { cwd: dir, env })
    return new Set(stdout.split('\0').filter(Boolean))
  } catch (error) {
    throw new CliError(`git ls-files failed (exit ${String((error as GitFailure).code)})`, 2)
  }
}
