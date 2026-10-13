import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CliError } from './errors'

/** null when the file does not exist; any other failure is an exit-2 error. */
export function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw new CliError(`${basename(path)}: cannot read (${code ?? 'unknown error'})`, 2)
  }
}

/**
 * Temp file in the same directory, then rename: never a half-written file.
 * An existing file keeps its permission bits; `mode` applies to new files.
 */
export function writeAtomic(path: string, content: string, mode: number): void {
  const temp = join(dirname(path), `.${basename(path)}.statesman-${process.pid}`)
  try {
    const existing = statSync(path, { throwIfNoEntry: false })
    const finalMode = existing ? existing.mode & 0o777 : mode
    rmSync(temp, { force: true }) // removes a stale file or a planted symlink, never its target
    writeFileSync(temp, content, { mode: finalMode, flag: 'wx' })
    chmodSync(temp, finalMode)
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    const code = (error as NodeJS.ErrnoException).code
    throw new CliError(`${basename(path)}: cannot write (${code ?? 'unknown error'})`, 2)
  }
}
