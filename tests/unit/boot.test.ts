import { describe, it, expect } from 'vitest'
import appConfig from '../../app/app.config'

describe('design tokens', () => {
  it('maps all seven semantic colors', () => {
    const colors = appConfig.ui?.colors ?? {}
    for (const name of ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral']) {
      expect(colors, `missing semantic color: ${name}`).toHaveProperty(name)
    }
  })
})
