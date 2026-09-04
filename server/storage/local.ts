import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import type { StateStore } from './types'

export class LocalStore implements StateStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const full = resolve(this.root, key)
    const rel = relative(resolve(this.root), full)
    if (rel.startsWith('..') || rel.startsWith(sep)) {
      throw new Error(`refusing to access a path outside the storage root: ${key}`)
    }
    return full
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const file = this.path(key)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, data)
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(key)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true })
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent<string>[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else {
          const key = relative(resolve(this.root), full).split(sep).join('/')
          if (key.startsWith(prefix)) out.push(key)
        }
      }
    }
    await walk(resolve(this.root))
    return out
  }
}
