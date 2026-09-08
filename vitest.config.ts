import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // `app/**` is written for Nuxt, which resolves `~~` to the project root.
      // These suites import those modules as plain ESM with no Nuxt build (see
      // tests/setup.ts), so the alias has to be restated here or every app
      // module that reaches into shared/ fails to resolve. Relative paths are
      // not the alternative: they resolve here and then break `nuxt build`,
      // which rewrites the output tree underneath them.
      '~~': fileURLToPath(new URL('.', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000
  }
})
