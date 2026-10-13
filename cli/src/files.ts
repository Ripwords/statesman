import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/** Temp file in the same directory, then rename: never a half-written file. */
export function writeAtomic(path: string, content: string, mode: number): void {
  const temp = join(dirname(path), `.${basename(path)}.statesman-${process.pid}`)
  try {
    writeFileSync(temp, content, { mode })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
