import { describe, it, expect, vi, afterEach } from 'vitest'
import appConfig from '../../app/app.config'

describe('design tokens', () => {
  it('maps all seven semantic colors', () => {
    const colors = appConfig.ui?.colors ?? {}
    for (const name of ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral']) {
      expect(colors, `missing semantic color: ${name}`).toHaveProperty(name)
    }
  })
})

describe('boot guard', () => {
  const original = { ...process.env }

  afterEach(() => {
    process.env = { ...original }
    vi.resetModules()
  })

  async function loadPlugin() {
    vi.resetModules()
    return import('../../server/plugins/00.env')
  }

  it('refuses to boot without an encryption key', async () => {
    delete process.env.STATESMAN_ENCRYPTION_KEY
    const { assertEnvironment } = await loadPlugin()
    expect(() => assertEnvironment()).toThrow(/STATESMAN_ENCRYPTION_KEY/)
  })

  it('refuses to boot on a key that is not 32 bytes', async () => {
    process.env.STATESMAN_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64')
    const { assertEnvironment } = await loadPlugin()
    expect(() => assertEnvironment()).toThrow(/32 bytes/)
  })

  it('boots with a valid environment', async () => {
    process.env.STATESMAN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
    const { assertEnvironment } = await loadPlugin()
    expect(() => assertEnvironment()).not.toThrow()
  })

  it('registers the guard as a nitro plugin', async () => {
    const plugin = await loadPlugin()
    expect(typeof plugin.default).toBe('function')
  })
})
