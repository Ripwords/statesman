<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: 'Projects · statesman' })

// No generic: Nitro types `/api/ui/projects` from the handler itself, so the
// row shape is derived from the server rather than restated here.
const { data: projects, status, error, refresh } = await useFetch('/api/ui/projects')

const creating = ref(false)

// Creating a project is admin-only server-side; a member is offered no button
// for it rather than a 403 after filling the form in.
const { isAdmin } = useAuth()

// v1 runs one organization per deployment (spec §5), so any row names it. On an
// empty list there is no row, and the server resolves it instead.
const org = computed(() => projects.value?.[0]?.org)

// Both formatters resolve against the runtime's locale, which differs between
// the server and the browser — every call site below sits inside <ClientOnly>
// so the difference is a swap rather than a hydration mismatch.
const bytes = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  style: 'unit',
  unit: 'byte',
  unitDisplay: 'narrow'
})
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between gap-4">
      <h1 class="scroll-mt-24 text-xl font-semibold tracking-tight text-balance">Projects</h1>
      <div class="flex items-center gap-3">
        <UBadge v-if="projects?.length" color="neutral" variant="subtle" class="tabular">
          {{ projects.length }}
        </UBadge>
        <UButton
          v-if="projects?.length && isAdmin"
          icon="i-lucide-plus"
          label="New Project"
          @click="creating = true"
        />
      </div>
    </div>

    <div v-if="status === 'pending'" class="space-y-3" aria-live="polite" aria-busy="true">
      <USkeleton v-for="n in 3" :key="n" class="h-24 w-full motion-reduce:animate-none" />
      <span class="sr-only">Loading Projects…</span>
    </div>

    <!--
      Before the empty state, deliberately. A failed request left `projects`
      empty, so a database blip rendered "No Projects Yet" — the most reassuring
      possible answer to "your state store is unreachable".
    -->
    <div v-else-if="error" aria-live="polite">
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Could Not Load Projects"
        description="The server did not answer. This is a problem reaching statesman, not a sign that you have no projects."
      >
        <template #actions>
          <UButton color="error" variant="outline" label="Retry" @click="refresh()" />
        </template>
      </UAlert>
    </div>

    <!--
      This copy used to say a project appears the first time Terraform writes to
      it. That was never true — an address statesman does not recognise is a 404
      (spec §9) — and believing it is what hid the missing create path for a
      whole phase. It says what actually happens now.
    -->
    <EmptyState
      v-else-if="!projects?.length"
      icon="i-lucide-boxes"
      title="No Projects Yet"
      :description="
        isAdmin
          ? 'Create a project here, then point a Terraform backend block at it. Projects are never created implicitly: an address that does not match one returns 404, so a typo cannot quietly split your state across two of them.'
          : 'No projects exist yet. Creating one is limited to admin accounts, so ask an admin to add the first one.'
      "
    >
      <div class="flex flex-wrap justify-center gap-2">
        <UButton
          v-if="isAdmin"
          icon="i-lucide-plus"
          label="Create Your First Project"
          @click="creating = true"
        />
        <UButton
          to="/tokens"
          label="Create a Token"
          icon="i-lucide-key-round"
          variant="outline"
          color="neutral"
        />
      </div>
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
            <span class="min-w-0 truncate font-medium" translate="no"
              >{{ p.org }}/{{ p.slug }}</span
            >
            <!--
              Gated on lockedAt, not lockedBy: `Who` is optional in Terraform's
              LockInfo, so a client that omits it held a lock the dashboard
              showed no sign of. See app/utils/lock.ts.

              `lockedBy` is whatever Terraform reported and can be arbitrarily
              long. The badge's own label slot already truncates; min-w-0 and
              max-w-full are what let the badge shrink far enough for that to
              take effect.
            -->
            <UBadge
              v-if="isLocked(p)"
              color="warning"
              variant="subtle"
              icon="i-lucide-lock"
              class="min-w-0 max-w-full"
              :label="`Locked by ${lockHolder(p)}`"
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

    <ProjectCreateModal v-model:open="creating" :org="org" @created="refresh()" />
  </div>
</template>
