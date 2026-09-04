import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { setup, useTestContext } from '@nuxt/test-utils/e2e'

// Build only. This suite never talks to a running server; it starts its own,
// badly, and watches it die.
await setup({ server: false, build: true })

type BootResult = { code: number | null; signal: NodeJS.Signals | null; output: string }

/** Ports are only reached if the guard has already failed, which is the bug. */
function unlikelyPort(): number {
  return 34_000 + Math.floor(Math.random() * 1000)
}

function entrypoint(): string {
  const { nuxt } = useTestContext()
  const dir = nuxt?.options.nitro.output?.dir
  if (!dir) throw new Error('the nitro output directory is not known')
  return resolve(dir, 'server/index.mjs')
}

/**
 * Runs the built server with the given environment and waits for it to exit.
 *
 * A server that is still up after `graceMs` is the regression: it is killed and
 * reported as running, so the assertion below fails with "still running" rather
 * than hanging until the suite times out.
 */
async function boot(env: NodeJS.ProcessEnv, graceMs = 15_000): Promise<BootResult> {
  const child = spawn('node', [entrypoint()], {
    env: { ...env, PORT: String(unlikelyPort()), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })

  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null]
  clearTimeout(timer)
  return { code, signal, output }
}

/** Everything the server needs, minus whatever a case removes. */
function goodEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: 'production', CONSOLA_LEVEL: '3' }
}

describe('the boot guard on the built server', () => {
  /**
   * This test exists because the guard did not work and the code said it did.
   * `server/plugins/00.env.ts` called `assertEnvironment()` bare inside an async
   * plugin, so the throw was a rejected promise: the process logged the failure,
   * bound its port, and served traffic. It was ruled not worth testing because
   * the wrapper is three lines — and the bug lived in exactly those three lines.
   */
  it('exits non-zero when STATESMAN_ENCRYPTION_KEY is missing', async () => {
    const env = goodEnv()
    delete env.STATESMAN_ENCRYPTION_KEY
    const result = await boot(env)

    expect({ code: result.code, signal: result.signal }).toEqual({ code: 1, signal: null })
    expect(result.output).toContain('STATESMAN_ENCRYPTION_KEY')
    // The load-bearing half: a process that got as far as listening is serving
    // requests it cannot encrypt, whatever it printed first.
    expect(result.output).not.toContain('Listening on')
  }, 60_000)

  it('exits non-zero when the key is present but not 32 bytes', async () => {
    // A truncated key is the realistic failure — a copy-paste that lost
    // characters — and it must not silently encrypt state nothing can read.
    const result = await boot({ ...goodEnv(), STATESMAN_ENCRYPTION_KEY: 'dG9vLXNob3J0' })

    expect(result.code).toBe(1)
    expect(result.output).toContain('32 bytes')
    expect(result.output).not.toContain('Listening on')
  }, 60_000)

  it('exits non-zero when BETTER_AUTH_SECRET is missing', async () => {
    const env = goodEnv()
    delete env.BETTER_AUTH_SECRET
    const result = await boot(env)

    expect(result.code).toBe(1)
    expect(result.output).not.toContain('Listening on')
  }, 60_000)

  it('still starts with a valid configuration', async () => {
    // The control. Without it, a harness that could never start a server at all
    // would pass every assertion above.
    const result = await boot(goodEnv(), 8000)

    expect(result.output).toContain('Listening on')
    // Killed by the grace timer because it was healthy, not exited on its own.
    expect(result.signal).toBe('SIGKILL')
  }, 60_000)
})
