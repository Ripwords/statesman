<script setup lang="ts">
import { diffJson } from '~/utils/diff'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const org = computed(() => String(route.params.org))
const slug = computed(() => String(route.params.project))
const a = computed(() => (typeof route.query.a === 'string' ? route.query.a : ''))
const b = computed(() => (typeof route.query.b === 'string' ? route.query.b : ''))
const selected = computed(() => Boolean(a.value && b.value))

useHead({ title: () => `Diff · ${org.value}/${slug.value} · statesman` })

// The timeline page resolves the project before it renders anything; this page
// has to as well, or it will happily draw a diff under a breadcrumb pointing at
// a project that does not exist. Shares the list's cache key, so it is free.
const { data: projects } = await useFetch('/api/ui/projects')
const project = computed(() =>
  projects.value?.find((p) => p.org === org.value && p.slug === slug.value) ?? null
)

if (import.meta.server && !project.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

// Two fetches over one route need distinct keys, and neither should fire until
// the query string actually names a version.
const { data: left, status: leftStatus, error: leftError } = await useFetch(
  () => `/api/ui/versions/${a.value}`,
  { key: 'diff-left', immediate: selected.value && project.value !== null, watch: [a] }
)
const { data: right, status: rightStatus, error: rightError } = await useFetch(
  () => `/api/ui/versions/${b.value}`,
  { key: 'diff-right', immediate: selected.value && project.value !== null, watch: [b] }
)

const loading = computed(() => leftStatus.value === 'pending' || rightStatus.value === 'pending')
const failed = computed(() => Boolean(leftError.value ?? rightError.value))

const lines = computed(() =>
  left.value && right.value ? diffJson(left.value.json, right.value.json) : []
)
</script>

<template>
  <div class="space-y-6">
    <UBreadcrumb
      :items="project
        ? [
          { label: 'Projects', to: '/' },
          { label: `${org}/${slug}`, to: `/projects/${org}/${slug}` },
          { label: 'Diff' }
        ]
        : [{ label: 'Projects', to: '/' }, { label: 'Diff' }]"
    />

    <h1 class="scroll-mt-24 text-xl font-semibold tracking-tight text-balance">
      Compare Versions
    </h1>

    <EmptyState
      v-if="!project"
      icon="i-lucide-search-x"
      title="Project Not Found"
      description="No project matches this address. It may have been renamed or removed — check the list for the current name."
    >
      <UButton to="/" label="Back to Projects" icon="i-lucide-arrow-left" />
    </EmptyState>

    <EmptyState
      v-else-if="!selected"
      icon="i-lucide-git-compare"
      title="Pick Two Versions"
      description="A comparison needs both an older and a newer version. Choose them on the project page and the address bar will carry the selection here."
    >
      <UButton
        :to="`/projects/${org}/${slug}`"
        label="Back to the Timeline"
        icon="i-lucide-arrow-left"
      />
    </EmptyState>

    <div v-else-if="loading" aria-live="polite" aria-busy="true">
      <USkeleton class="h-64 w-full motion-reduce:animate-none" />
      <span class="sr-only">Loading Versions…</span>
    </div>

    <div v-else-if="failed" aria-live="polite">
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Those Versions Could Not Be Read"
        description="One of them may have been removed by retention. Pick another pair on the project page and try again."
      />
    </div>

    <StateDiff v-else :lines="lines" />
  </div>
</template>
