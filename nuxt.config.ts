export default defineNuxtConfig({
  compatibilityDate: '2026-09-04',
  // Do not add @nuxt/icon, @nuxt/fonts or @nuxtjs/color-mode here — Nuxt UI
  // registers all three, and listing them again breaks the build.
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  colorMode: { preference: 'system', fallback: 'dark' },
  app: {
    head: {
      title: 'statesman',
      meta: [
        { name: 'theme-color', content: '#18181b', media: '(prefers-color-scheme: dark)' },
        { name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' }
      ]
    }
  },
  typescript: { strict: true, typeCheck: true }
})
