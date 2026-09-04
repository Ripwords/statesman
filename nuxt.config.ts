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
  nitro: {
    // Nitro's scheduler exists only on a long-running preset; on Vercel the
    // task is never invoked, which is why the task itself also checks and why
    // docs/deploy-vercel.md documents the external trigger.
    experimental: { tasks: true },
    // Off-peak and off the hour, so a fleet of deployments does not all sweep
    // their blob stores at 03:00 exactly.
    scheduledTasks: { '17 3 * * *': ['retention'] }
  },
  typescript: { strict: true, typeCheck: true }
})
