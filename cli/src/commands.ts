import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileFor, parseManifest, type Manifest } from '../../shared/schemas/manifest'
import { CliError } from './errors'
import { checkServer, fetchCheckout } from './client'
import { gitIgnored, gitTracked } from './git'
import { readOrNull, removeStaleTemps, writeAtomic } from './files'
import { loadHcl } from './wasm'
import { findStrays } from './strays'
import { isDrift, reportEnvironment, type FileReport } from './report'

export type RunOptions = {
  dir: string
  envs: string[]
  token: string | undefined
  serverOverride: string | undefined
  fetchImpl?: typeof fetch
}
export type Reported = FileReport & { action?: 'written' | 'refused' }
export type CommandResult = { reports: Reported[]; exitCode: 0 | 1 }

function loadManifest(dir: string): Manifest {
  const text = readOrNull(join(dir, 'statesman.json'))
  if (text === null) throw new CliError(`no statesman.json in ${dir}`, 2)
  try {
    return parseManifest(text)
  } catch (error) {
    throw new CliError((error as Error).message, 2)
  }
}

function selectEnvs(manifest: Manifest, requested: string[]): string[] {
  for (const env of requested) {
    if (!manifest.environments.includes(env)) {
      throw new CliError(
        `environment "${env}" is not in statesman.json (${manifest.environments.join(', ')})`,
        2
      )
    }
  }
  return requested.length > 0 ? requested : manifest.environments
}

async function collect(opts: RunOptions): Promise<{ manifest: Manifest; reports: FileReport[] }> {
  const manifest = loadManifest(opts.dir)
  const envs = selectEnvs(manifest, opts.envs)
  const { token } = opts
  if (!token)
    throw new CliError(
      `set STATESMAN_TOKEN to a token with Read Variables for ${manifest.project}`,
      2
    )
  if (opts.serverOverride !== undefined) checkServer(opts.serverOverride, 'STATESMAN_URL')
  const server = opts.serverOverride ?? manifest.server
  const checkouts = await Promise.all(
    envs.map((env) =>
      fetchCheckout({ server, project: manifest.project, env, token, fetchImpl: opts.fetchImpl })
    )
  )
  const hcl = await loadHcl()
  const reports = envs.flatMap((env, i) =>
    reportEnvironment({
      manifest,
      env,
      checkout: checkouts[i]!,
      read: (file) => readOrNull(join(opts.dir, file)),
      hcl
    })
  )
  const tracked = await gitTracked(opts.dir)
  for (const s of findStrays(readdirSync(opts.dir), tracked, manifest)) {
    reports.push({
      env: null,
      file: s.file,
      kind: null,
      state: 'stray',
      detail: [s.env],
      desired: null
    })
  }
  return { manifest, reports }
}

export async function status(opts: RunOptions): Promise<CommandResult> {
  const { reports } = await collect(opts)
  return { reports, exitCode: reports.some(isDrift) ? 1 : 0 }
}

export async function pull(opts: RunOptions & { force: boolean }): Promise<CommandResult> {
  const manifest = loadManifest(opts.dir)
  // Before any network call or write: a vars file git would commit is a leak.
  for (const env of selectEnvs(manifest, opts.envs)) {
    const file = fileFor(manifest.files.vars, env)
    if ((await gitIgnored(opts.dir, file)) === false) {
      // check-ignore reports a tracked file as not ignored whatever .gitignore says.
      if ((await gitTracked(opts.dir)).has(file)) {
        throw new CliError(
          `${file} is tracked by git and would be committed; untrack it with ` +
            `\`git rm --cached ${file}\` and make sure .gitignore covers it`,
          2
        )
      }
      throw new CliError(
        `${file} is not gitignored and would be committed; add it to .gitignore first`,
        2
      )
    }
  }
  // A pull that crashed between write and rename left a temp copy that no
  // *.tfvars ignore rule matches. Clear them before writing anything new.
  const managed = selectEnvs(manifest, opts.envs).flatMap((env) =>
    (['vars', 'backend', 'env'] as const).flatMap((kind) => {
      const pattern = manifest.files[kind]
      return pattern === undefined ? [] : [fileFor(pattern, env)]
    })
  )
  removeStaleTemps(opts.dir, managed)
  const { reports } = await collect(opts)
  const out: Reported[] = reports.map((r) => {
    if (r.desired === null || r.state === 'ok') return r
    // A file that differs is only overwritten with --force; .env merges keep foreign lines.
    const mayWrite = r.state === 'missing' || opts.force
    if (!mayWrite) return { ...r, action: 'refused' }
    // Vars files hold secrets: always 0600, even over a looser existing file.
    const mode = r.kind === 'vars' ? { always: 0o600 } : { whenNew: 0o644 }
    writeAtomic(join(opts.dir, r.file), r.desired, mode)
    return { ...r, action: 'written' }
  })
  const drift = out.some((r) => r.action === 'refused' || r.state === 'stray')
  return { reports: out, exitCode: drift ? 1 : 0 }
}
