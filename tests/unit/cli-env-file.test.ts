import { describe, it, expect } from 'vitest'
import { envFileDiffers, mergeEnvFile, ownedEntries } from '../../cli/src/env-file'

const files = { vars: 'client.tfvars', backend: 'backend.client.hcl' }
const owned = ownedEntries(files, 'client')

describe('ownedEntries', () => {
  it('lists TF_DATA_DIR, init and each var-file command in order', () => {
    expect(owned.map(([k]) => k)).toEqual([
      'TF_DATA_DIR',
      'TF_CLI_ARGS_init',
      'TF_CLI_ARGS_plan',
      'TF_CLI_ARGS_apply',
      'TF_CLI_ARGS_destroy',
      'TF_CLI_ARGS_import',
      'TF_CLI_ARGS_refresh',
      'TF_CLI_ARGS_console'
    ])
    expect(Object.fromEntries(owned)).toMatchObject({
      TF_DATA_DIR: '.terraform-client',
      TF_CLI_ARGS_init: '-backend-config=backend.client.hcl',
      TF_CLI_ARGS_plan: '-var-file=client.tfvars'
    })
  })
  it('leaves out init when there is no backend file', () => {
    expect(ownedEntries({ vars: 'client.tfvars' }, 'client').map(([k]) => k)).not.toContain(
      'TF_CLI_ARGS_init'
    )
  })
})

describe('mergeEnvFile', () => {
  it('starts a new file with a header comment and every owned key', () => {
    const out = mergeEnvFile(null, owned)
    expect(out.split('\n')[0]).toMatch(/^# /)
    expect(out).toContain('TF_DATA_DIR=.terraform-client\n')
    expect(out.endsWith('\n')).toBe(true)
  })

  it('keeps foreign lines in place and updates owned keys where they stand', () => {
    const existing =
      '# mine\nAWS_PROFILE=client\nTF_DATA_DIR=.terraform\nAWS_REGION=ap-southeast-1\n'
    const out = mergeEnvFile(existing, owned).split('\n')
    expect(out.slice(0, 4)).toEqual([
      '# mine',
      'AWS_PROFILE=client',
      'TF_DATA_DIR=.terraform-client',
      'AWS_REGION=ap-southeast-1'
    ])
    expect(out.filter((l) => l.startsWith('TF_DATA_DIR')).length).toBe(1)
    expect(out).toContain('TF_CLI_ARGS_console=-var-file=client.tfvars')
  })

  it('keeps an export prefix and replaces a quoted owned value', () => {
    const out = mergeEnvFile('export TF_DATA_DIR=".old"\n', owned)
    expect(out).toContain('export TF_DATA_DIR=.terraform-client\n')
    expect(out).not.toContain('.old')
  })

  it('removes TF_CLI_ARGS_init when the backend file goes away', () => {
    const withInit = mergeEnvFile(null, owned)
    const without = mergeEnvFile(withInit, ownedEntries({ vars: 'client.tfvars' }, 'client'))
    expect(without).not.toContain('TF_CLI_ARGS_init')
  })

  it('preserves CRLF line endings', () => {
    const out = mergeEnvFile('AWS_PROFILE=x\r\nTF_DATA_DIR=old\r\n', owned)
    expect(out).toContain('AWS_PROFILE=x\r\nTF_DATA_DIR=.terraform-client\r\n')
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('envFileDiffers', () => {
  it('is empty for a merged file with foreign lines', () => {
    expect(envFileDiffers(mergeEnvFile('AWS_PROFILE=x\n', owned), owned)).toEqual([])
  })
  it('names a missing, changed or no-longer-owned key', () => {
    expect(envFileDiffers('TF_DATA_DIR=.terraform\n', owned)).toEqual(
      expect.arrayContaining(['TF_DATA_DIR', 'TF_CLI_ARGS_plan'])
    )
    const stale = mergeEnvFile(null, owned)
    expect(envFileDiffers(stale, ownedEntries({ vars: 'client.tfvars' }, 'client'))).toEqual([
      'TF_CLI_ARGS_init'
    ])
  })
})
