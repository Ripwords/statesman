<script setup lang="ts">
import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui'

const { user, signOut } = useAuth()

// Every authenticated route renders through this layout, and /login sets the
// same attribute for itself. Without it assistive technology has to guess the
// document language.
useHead({ htmlAttrs: { lang: 'en' } })

const links: NavigationMenuItem[] = [
  { label: 'Projects', icon: 'i-lucide-boxes', to: '/' },
  { label: 'Tokens', icon: 'i-lucide-key-round', to: '/tokens' }
]

const toast = useToast()

async function onSignOut() {
  const { ok } = await signOut()
  if (ok) return
  // signOut leaves the local session alone when the server did not confirm, so
  // the UI must say so rather than silently look signed in.
  toast.add({
    title: 'Could Not Sign Out',
    description:
      'The server did not confirm the sign-out, so you are still signed in. Check your connection and try again.',
    color: 'error',
    icon: 'i-lucide-triangle-alert'
  })
}

const accountItems: DropdownMenuItem[][] = [
  [
    {
      label: 'Sign Out',
      icon: 'i-lucide-log-out',
      onSelect: () => {
        void onSignOut()
      }
    }
  ]
]
</script>

<template>
  <div
    class="min-h-dvh touch-manipulation bg-default text-default [-webkit-tap-highlight-color:transparent]"
  >
    <a
      href="#main"
      class="sr-only rounded-md bg-primary px-4 py-2 text-inverted focus-visible:not-sr-only focus-visible:fixed focus-visible:start-3 focus-visible:top-3 focus-visible:z-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      Skip to Content
    </a>

    <header class="sticky top-0 z-40 border-b border-default bg-default/85 backdrop-blur">
      <div class="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <NuxtLink
          to="/"
          class="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight transition-[color] hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <UIcon name="i-lucide-landmark" class="size-5 text-primary" aria-hidden="true" />
          <!--
            Hidden visually below the sm breakpoint so the icon, the nav and
            the two header buttons all fit on a 320px screen. It stays in the
            accessibility tree, so the link keeps the name "statesman".
          -->
          <span class="sr-only sm:not-sr-only" translate="no">statesman</span>
        </NuxtLink>

        <UNavigationMenu :items="links" aria-label="Main" class="min-w-0" />

        <div class="ms-auto flex shrink-0 items-center gap-2">
          <UColorModeButton />
          <UDropdownMenu v-if="user" :items="accountItems">
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-user"
              :aria-label="`Account menu for ${user.email}`"
            />
          </UDropdownMenu>
        </div>
      </div>
    </header>

    <!--
      tabindex="-1" is what makes the skip link actually move focus. Without it
      the anchor scrolls but focus stays on <body>, which Chromium papers over
      with its sequential-focus starting point and VoiceOver/Safari does not.
    -->
    <main
      id="main"
      tabindex="-1"
      class="mx-auto max-w-6xl scroll-mt-24 px-4 py-8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:px-6"
    >
      <slot />
    </main>
  </div>
</template>

<style>
/*
  The header is sticky, so anything scrolled to the top of the viewport by the
  browser lands underneath it. Scroll margin therefore belongs on whatever
  actually receives focus, not on <main> — a row Shift+Tabbed into from below
  was otherwise more than half hidden behind the header.

  One :where() rule rather than a utility class per element: it reaches the
  focusable elements inside Nuxt UI's own components (nav links, breadcrumbs,
  switches, select triggers) that no class of ours can touch, and its zero
  specificity means any explicit scroll-mt-* still wins.
*/
:where(
  a[href],
  area,
  button,
  input,
  select,
  textarea,
  summary,
  iframe,
  [tabindex]:not([tabindex='-1'])
) {
  scroll-margin-top: 6rem;
  scroll-margin-bottom: 2rem;
}
</style>
