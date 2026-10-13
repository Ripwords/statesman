import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** null when `dir` is not inside a git work tree. */
export async function gitIgnored(dir: string, file: string): Promise<boolean | null> {
  try {
    await run('git', ['check-ignore', '-q', file], { cwd: dir })
    return true
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 1) return false
    return null // 128: not a repository; ENOENT: no git installed
  }
}

export async function gitTracked(dir: string): Promise<Set<string>> {
  try {
    const { stdout } = await run('git', ['ls-files', '-z', '--', '.'], { cwd: dir })
    return new Set(stdout.split('\0').filter(Boolean))
  } catch {
    return new Set()
  }
}
