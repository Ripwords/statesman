<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: 'Projects · statesman' })

// No generic: Nitro types `/api/ui/projects` from the handler itself, so the
// row shape is derived from the server rather than restated here.
const { data: projects, status } = await useFetch('/api/ui/projects')

// Both formatters resolve against the runtime's locale, which differs between
// the server and the browser — every call site below sits inside <ClientOnly>
// so the difference is a swap rather than a hydration mismatch.
const bytes = new Intl.NumberFormat(undefined, {
  notation: 'compact', style: 'unit', unit: 'byte', unitDisplay: 'narrow'
})
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between gap-4">
      <h1 class="scroll-mt-24 text-xl font-semibold tracking-tight text-balance">Projects</h1>
      <UBadge v-if="projects?.length" color="neutral" variant="subtle" class="tabular">
        {{ projects.length }}
      </UBadge>
    </div>

    <div v-if="status === 'pending'" class="space-y-3" aria-live="polite" aria-busy="true">
      <USkeleton v-for="n in 3" :key="n" class="h-24 w-full motion-reduce:animate-none" />
      <span class="sr-only">Loading Projects…</span>
    </div>

    <EmptyState
      v-else-if="!projects?.length"
      icon="i-lucide-boxes"
      title="No Projects Yet"
      description="A project appears here the first time Terraform writes state to it. Create a token, point a backend block at this server, and run apply."
    >
      <UButton to="/tokens" label="Create a Token" icon="i-lucide-key-round" />
    </EmptyState>

    <ul v-else class="grid gap-3">
      <li
        v-for="p in projects"
        :key="p.id"
        class="[contain-intrinsic-size:auto_6rem] min-w-0 [content-visibility:auto]"
      >
        <NuxtLink
          :to="`/projects/${p.org}/${p.slug}`"
          class="block rounded-lg border border-default p-4 transition-[color,background-color,border-color] hover:border-primary hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span class="min-w-0 truncate font-medium" translate="no">{{ p.org }}/{{ p.slug }}</span>
            <!--
              `lockedBy` is whatever Terraform reported and can be arbitrarily long.
              The badge's own label slot already truncates; min-w-0/max-w-full is
              what lets the badge shrink far enough for that to take effect.
            -->
            <UBadge
              v-if="p.lockedBy"
              color="warning"
              variant="subtle"
              icon="i-lucide-lock"
              class="min-w-0 max-w-full"
              :label="`Locked by ${p.lockedBy}`"
            />
          </div>

          <dl class="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted tabular">
            <div class="flex min-w-0 gap-1.5">
              <dt>Serial</dt>
              <dd>{{ p.serial ?? '—' }}</dd>
            </div>
            <div class="flex min-w-0 gap-1.5">
              <dt>Versions</dt>
              <dd>{{ p.versionCount }}</dd>
            </div>
            <div class="flex min-w-0 gap-1.5">
              <dt>Size</dt>
              <dd>
                <ClientOnly fallback="—">
                  {{ p.sizeBytes === null ? '—' : bytes.format(p.sizeBytes) }}
                </ClientOnly>
              </dd>
            </div>
            <div class="flex min-w-0 gap-1.5">
              <dt>Updated</dt>
              <dd>
                <ClientOnly fallback="—">
                  {{ p.updatedAt ? when.format(new Date(p.updatedAt)) : '—' }}
                </ClientOnly>
              </dd>
            </div>
          </dl>
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
