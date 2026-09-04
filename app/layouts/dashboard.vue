<script setup lang="ts">
import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui'

const { user, signOut } = useAuth()

const links: NavigationMenuItem[] = [
  { label: 'Projects', icon: 'i-lucide-boxes', to: '/' },
  { label: 'Tokens', icon: 'i-lucide-key-round', to: '/tokens' }
]

const accountItems: DropdownMenuItem[][] = [
  [{ label: 'Sign Out', icon: 'i-lucide-log-out', onSelect: () => { void signOut() } }]
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
          class="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <UIcon name="i-lucide-landmark" class="size-5 text-primary" aria-hidden="true" />
          <!-- Hidden visually on the narrowest screens so the single nav
               landmark below never has to compete for width, but still the
               link's accessible name. -->
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

    <main id="main" class="mx-auto max-w-6xl scroll-mt-24 px-4 py-8 sm:px-6">
      <slot />
    </main>
  </div>
</template>
