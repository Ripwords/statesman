// Nuxt 4 reads app.config.ts from srcDir (app/), not the project root. A
// root-level copy is silently ignored — the tokens below would never apply.
//
// `zinc` for neutral and `indigo` for primary read as infrastructure tooling
// rather than consumer product: cool, low-saturation, legible in both color
// modes. `rose` for error keeps destructive actions distinct from the `amber`
// lock-held warning, which matters because both appear on the project page at
// once.
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'indigo',
      secondary: 'violet',
      success: 'emerald',
      info: 'sky',
      warning: 'amber',
      error: 'rose',
      neutral: 'zinc'
    }
  }
})
