import type { HclToolkit } from '../../server/hcl/toolkit'
import type { CheckoutResponse } from '../../shared/schemas/backend'
import { fileFor, type FileKind, type Manifest } from '../../shared/schemas/manifest'
import { renderBackend, renderVars } from './render'
import { envFileDiffers, mergeEnvFile, ownedEntries } from './env-file'
import { describeDiff, diffMaps, isEmptyDiff, LocalParseError, parseLocal } from './compare'

export type FileState = 'ok' | 'missing' | 'differs' | 'unreadable' | 'stray' | 'no-backend'

export type FileReport = {
  env: string | null
  file: string
  kind: FileKind | null
  state: FileState
  /** Variable or key names, or one unreadable message. Never values. */
  detail: string[]
  /** What pull would write; null when nothing should be written. */
  desired: string | null
}

const DRIFT: ReadonlySet<FileState> = new Set(['missing', 'differs', 'unreadable', 'stray'])
export const isDrift = (r: FileReport) => DRIFT.has(r.state)

function mapFile(
  env: string,
  kind: 'vars' | 'backend',
  file: string,
  expected: Record<string, unknown>,
  desired: string,
  local: string | null,
  hcl: HclToolkit
): FileReport {
  const base = { env, file, kind, desired }
  if (local === null) return { ...base, state: 'missing', detail: [] }
  try {
    const diff = diffMaps(expected, parseLocal(local, file, hcl))
    return isEmptyDiff(diff)
      ? { ...base, state: 'ok', detail: [] }
      : { ...base, state: 'differs', detail: describeDiff(diff) }
  } catch (error) {
    if (error instanceof LocalParseError)
      return { ...base, state: 'unreadable', detail: [error.message] }
    throw error
  }
}

export function reportEnvironment(args: {
  manifest: Manifest
  env: string
  checkout: CheckoutResponse
  read: (file: string) => string | null
  hcl: HclToolkit
}): FileReport[] {
  const { manifest, env, checkout, read, hcl } = args
  const varsFile = fileFor(manifest.files.vars, env)
  const reports: FileReport[] = [
    mapFile(
      env,
      'vars',
      varsFile,
      checkout.variables,
      renderVars(checkout.variables, varsFile),
      read(varsFile),
      hcl
    )
  ]

  let backendFile: string | undefined
  if (manifest.files.backend) {
    const file = fileFor(manifest.files.backend, env)
    if (checkout.backend === null) {
      reports.push({ env, file, kind: 'backend', state: 'no-backend', detail: [], desired: null })
    } else {
      backendFile = file
      reports.push(
        mapFile(
          env,
          'backend',
          file,
          checkout.backend,
          renderBackend(checkout.backend),
          read(file),
          hcl
        )
      )
    }
  }

  if (manifest.files.env) {
    const file = fileFor(manifest.files.env, env)
    const owned = ownedEntries({ vars: varsFile, backend: backendFile }, env)
    const local = read(file)
    const desired = mergeEnvFile(local, owned)
    if (local === null) {
      reports.push({ env, file, kind: 'env', state: 'missing', detail: [], desired })
    } else {
      const differing = envFileDiffers(local, owned)
      reports.push({
        env,
        file,
        kind: 'env',
        state: differing.length ? 'differs' : 'ok',
        detail: differing,
        desired
      })
    }
  }
  return reports
}
