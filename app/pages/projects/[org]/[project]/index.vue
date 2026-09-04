<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })

import { FetchError } from 'ofetch'

const route = useRoute()
const org = computed(() => String(route.params.org))
const slug = computed(() => String(route.params.project))
useHead({ title: () => `${org.value}/${slug.value} · statesman` })

// Shares a cache key with the project list, so arriving from there costs no
// extra request. Row types come from Nitro's typed routes.
const {
  data: projects,
  error: projectsError,
  refresh: refreshProjects
} = await useFetch('/api/ui/projects')
const current = computed(
  () => projects.value?.find((p) => p.org === org.value && p.slug === slug.value) ?? null
)

// An address that names no project is a 404, not a 200 with a sad face on it.
// Only when the list actually loaded, though: a failed request must not be
// reported as a missing project.
if (import.meta.server && !current.value && !projectsError.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

type Version = NonNullable<typeof history.value>['versions'][number]

// `immediate` is read once, at setup, and `projects` above is already awaited
// on both server and client — so a real project fetches its timeline during
// SSR, and an unknown one never fires a request for `undefined`.
const { data: history, refresh } = await useFetch(
  () => `/api/ui/projects/${current.value?.id}/versions`,
  { immediate: current.value !== null, watch: [current] }
)

// The comparison lives in the URL so it can be shared and reloaded.
const compareA = computed({
  get: () => (typeof route.query.a === 'string' ? route.query.a : ''),
  set: (value: string) => {
    void navigateTo({ query: { ...route.query, a: value || undefined } })
  }
})
const compareB = computed({
  get: () => (typeof route.query.b === 'string' ? route.query.b : ''),
  set: (value: string) => {
    void navigateTo({ query: { ...route.query, b: value || undefined } })
  }
})

const versionOptions = computed(() =>
  (history.value?.versions ?? []).map((v) => ({ label: `#${v.serial ?? '?'}`, value: v.id }))
)

const notice = ref<string | null>(null)
const noticeEl = useTemplateRef<HTMLElement>('noticeEl')

/**
 * The control that triggers each of these actions lives inside the thing the
 * action removes — the lock banner, or a timeline row. Focus would land on
 * <body>, so it is moved to the message that replaced it, which also reads that
 * message out. That is why the container is not an aria-live region: focus
 * already announces it, and both would announce it twice.
 */
async function announce(message: string) {
  notice.value = message
  await nextTick()
  noticeEl.value?.focus()
}

/**
 * `lockedBy` comes from the project list, not the version list, so refreshing
 * only the timeline would leave the banner up after a successful unlock.
 */
async function onLockReleased() {
  await Promise.all([refreshProjects(), refresh()])
  await announce('State unlocked. Terraform can apply against this project again.')
}

const pendingRollback = ref<Version | null>(null)
const rollingBack = ref(false)
const rollbackError = ref<string | null>(null)

/**
 * Says what actually went wrong. Until Lane A's admin API merges every attempt
 * is a 404, and "check that the version still exists" would be a lie in the one
 * case that happens today.
 */
function rollbackMessage(error: unknown): string {
  const status = error instanceof FetchError ? error.statusCode : undefined
  switch (status) {
    case 404:
      return 'That version no longer exists. Reload the timeline, then try again.'
    case 401:
    case 403:
      return 'You are not allowed to roll this project back. Sign in again, then try again.'
    case 409:
    case 423:
      return 'The state is locked, so it cannot be rewritten. Release the lock first, then roll back.'
    default:
      return 'Could not roll back. Check your connection, then try again.'
  }
}

async function rollback() {
  const version = pendingRollback.value
  const project = current.value
  if (!version || !project) return
  rollingBack.value = true
  rollbackError.value = null
  try {
    // Built by Lane A (Task A6). Until that lane merges this route 404s, and
    // rollbackMessage says so.
    await $fetch('/api/admin/rollback', {
      method: 'POST',
      body: { projectId: project.id, versionId: version.id }
    })
    const serial = version.serial
    pendingRollback.value = null
    await Promise.all([refreshProjects(), refresh()])
    await announce(
      `Rolled back to version #${serial ?? '—'}. It is now the current version, and the timeline kept every earlier one.`
    )
  } catch (error) {
    rollbackError.value = rollbackMessage(error)
  } finally {
    rollingBack.value = false
  }
}

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const bytes = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  style: 'unit',
  unit: 'byte',
  unitDisplay: 'narrow'
})
</script>

<template>
  <div class="space-y-6">
    <UBreadcrumb :items="[{ label: 'Projects', to: '/' }, { label: `${org}/${slug}` }]" />

    <h1 class="scroll-mt-24 text-xl font-semibold tracking-tight text-balance" translate="no">
      {{ org }}/{{ slug }}
    </h1>

    <div v-if="projectsError" aria-live="polite">
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Could Not Load This Project"
        description="The server did not answer. This is a problem reaching statesman, not a sign that the project is gone."
      >
        <template #actions>
          <UButton color="error" variant="outline" label="Retry" @click="refreshProjects()" />
        </template>
      </UAlert>
    </div>

    <EmptyState
      v-else-if="!current"
      icon="i-lucide-search-x"
      title="Project Not Found"
      description="No project matches this address. It may have been renamed or removed — check the list for the current name."
    >
      <UButton to="/" label="Back to Projects" icon="i-lucide-arrow-left" />
    </EmptyState>

    <template v-else>
      <!--
        lockedAt, not lockedBy: a client that omits `Who` from its LockInfo held
        a lock this banner never rendered, which also removed the only
        Force Unlock button in the product. See app/utils/lock.ts.
      -->
      <LockBanner
        v-if="isLocked(current)"
        :project-id="current.id"
        :who="current.lockedBy"
        :since="current.lockedAt"
        @released="onLockReleased"
      />

      <div
        v-else-if="notice"
        ref="noticeEl"
        tabindex="-1"
        class="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <UAlert
          color="success"
          variant="subtle"
          icon="i-lucide-circle-check"
          :description="notice"
          :close="true"
          @update:open="notice = null"
        />
      </div>

      <EmptyState
        v-if="!history || history.versions.length === 0"
        icon="i-lucide-history"
        title="No Versions Yet"
        description="Run terraform apply against this project and the first version appears here."
      />

      <div v-else class="space-y-4">
        <div class="flex flex-wrap items-end gap-3">
          <UFormField label="Compare" name="compare-a" class="w-44">
            <USelect
              v-model="compareA"
              :items="versionOptions"
              placeholder="Older version…"
              class="w-full"
            />
          </UFormField>
          <UFormField label="With" name="compare-b" class="w-44">
            <USelect
              v-model="compareB"
              :items="versionOptions"
              placeholder="Newer version…"
              class="w-full"
            />
          </UFormField>
          <UButton
            :disabled="!compareA || !compareB || compareA === compareB"
            :to="`/projects/${org}/${slug}/diff?a=${compareA}&b=${compareB}`"
            label="View Diff"
            icon="i-lucide-git-compare"
          />
        </div>

        <ol class="space-y-2">
          <li
            v-for="v in history.versions"
            :key="v.id"
            class="[contain-intrinsic-size:auto_3.5rem] flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-default px-4 py-3 [content-visibility:auto]"
          >
            <UBadge
              v-if="v.id === history.currentVersionId"
              color="success"
              variant="subtle"
              label="Current"
            />
            <span class="font-medium tabular">#{{ v.serial ?? '—' }}</span>
            <span class="min-w-0 truncate text-sm text-muted">
              {{ v.authorName ?? v.authorEmail ?? 'Unknown' }}
            </span>
            <span class="text-sm text-muted tabular">
              <ClientOnly fallback="—">{{ when.format(new Date(v.createdAt)) }}</ClientOnly>
            </span>
            <span class="text-sm text-muted tabular">
              <ClientOnly fallback="—">{{ bytes.format(v.sizeBytes) }}</ClientOnly>
            </span>
            <UButton
              v-if="v.id !== history.currentVersionId"
              class="ms-auto"
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-rotate-ccw"
              :aria-label="`Roll back to version ${v.serial ?? v.id}`"
              @click="pendingRollback = v"
            />
          </li>
        </ol>
      </div>
    </template>

    <UModal
      :open="pendingRollback !== null"
      title="Roll Back to This Version?"
      :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
      @update:open="
        (value) => {
          if (!value) pendingRollback = null
        }
      "
    >
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-muted text-pretty">
            This writes the contents of version #{{ pendingRollback?.serial ?? '—' }} as a new
            version. Nothing is deleted and the timeline keeps every entry. The next terraform plan
            will read the restored state.
          </p>
          <div aria-live="polite">
            <UAlert
              v-if="rollbackError"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :description="rollbackError"
            />
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="pendingRollback = null" />
          <UButton
            color="primary"
            :loading="rollingBack"
            :label="rollingBack ? 'Rolling Back…' : 'Roll Back'"
            @click="rollback"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
