<script setup lang="ts">
import { FetchError } from 'ofetch'
import type { TableColumn } from '@nuxt/ui'
import { formatValue } from '~/utils/variable-value'

const props = defineProps<{ projectId: string }>()

const route = useRoute()
const { isAdmin } = useAuth()
const origin = useRequestURL().origin

const { data: environments, refresh: refreshEnvironments } = await useFetch(
  () => `/api/ui/projects/${props.projectId}/environments`
)

const envId = computed<string | null>(() => {
  const list = environments.value ?? []
  const wanted = typeof route.query.env === 'string' ? route.query.env : null
  return list.find((e) => e.slug === wanted)?.id ?? list[0]?.id ?? null
})
const env = computed(() => environments.value?.find((e) => e.id === envId.value) ?? null)
const envSlug = computed({
  get: () => env.value?.slug ?? '',
  set: (value: string) => {
    void navigateTo({ query: { ...route.query, env: value } })
  }
})
const envOptions = computed(() =>
  (environments.value ?? []).map((e) => ({ label: e.slug, value: e.slug }))
)

const {
  data: variables,
  error: variablesError,
  refresh: refreshVariables
} = await useFetch(() => `/api/ui/environments/${envId.value}/variables`, {
  immediate: envId.value !== null,
  watch: [envId]
})
type Row = NonNullable<typeof variables.value>['rows'][number]

const rows = computed(() => variables.value?.rows ?? [])
const showStatus = computed(() => rows.value.some((r) => r.status !== null))

const columns = computed<TableColumn<Row>[]>(() => [
  { accessorKey: 'name', header: 'Name' },
  ...(showStatus.value ? [{ accessorKey: 'status', header: 'Status' }] : []),
  { id: 'value', header: 'Value' },
  { accessorKey: 'description', header: 'Description' },
  { accessorKey: 'updatedAt', header: 'Updated' },
  ...(isAdmin.value
    ? [{ id: 'actions', header: () => h('span', { class: 'sr-only' }, 'Actions') }]
    : [])
])

const statusColor = {
  missing: 'error',
  set: 'success',
  optional: 'neutral',
  undeclared: 'warning'
} as const

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
function relativeTime(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60]
  ]
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return relative.format(seconds, 'second')
}

const createEnvOpen = ref(false)
const editOpen = ref(false)
const editing = ref<Row | null>(null)
const importOpen = ref(false)
const pendingDelete = ref<string | null>(null)
const deleteEnvOpen = ref(false)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

function openAdd() {
  editing.value = null
  editOpen.value = true
}
function openEdit(row: Row) {
  editing.value = row
  editOpen.value = true
}

function failure(error: unknown): string {
  return (
    (error instanceof FetchError ? error.statusMessage : undefined) ??
    'Could not delete. Check your connection, then try again.'
  )
}

async function removeVariable() {
  const name = pendingDelete.value
  if (!name || !envId.value) return
  deleting.value = true
  deleteError.value = null
  try {
    await $fetch(`/api/ui/environments/${envId.value}/variables/${encodeURIComponent(name)}`, {
      method: 'DELETE'
    })
    pendingDelete.value = null
    await refreshVariables()
  } catch (error) {
    deleteError.value = failure(error)
  } finally {
    deleting.value = false
  }
}

async function removeEnvironment() {
  if (!envId.value) return
  deleting.value = true
  deleteError.value = null
  try {
    await $fetch(`/api/ui/environments/${envId.value}`, { method: 'DELETE' })
    deleteEnvOpen.value = false
    await navigateTo({ query: { ...route.query, env: undefined } })
    await refreshEnvironments()
  } catch (error) {
    deleteError.value = failure(error)
  } finally {
    deleting.value = false
  }
}

async function onEnvironmentCreated(created: { slug: string }) {
  await refreshEnvironments()
  await navigateTo({ query: { ...route.query, env: created.slug } })
}

const projectPath = computed(() => String(route.params.org) + '/' + String(route.params.project))
const curl = computed(
  () =>
    `curl -fsS -u "statesman:$STATESMAN_TOKEN" ${origin}/api/vars/${projectPath.value}/${env.value?.slug ?? '<env>'} -o statesman.auto.tfvars.json`
)
</script>

<template>
  <div class="space-y-4">
    <EmptyState
      v-if="!environments || environments.length === 0"
      icon="i-lucide-layers"
      title="No environments yet"
      description="An environment holds one set of variables, such as staging or production. Create one to start adding values."
    >
      <UButton
        v-if="isAdmin"
        label="New environment"
        icon="i-lucide-plus"
        @click="createEnvOpen = true"
      />
    </EmptyState>

    <template v-else>
      <div class="flex flex-wrap items-center gap-3">
        <h2 v-if="environments.length === 1" class="text-lg font-semibold" translate="no">
          {{ environments[0]?.slug }}
        </h2>
        <USelect
          v-else
          v-model="envSlug"
          :items="envOptions"
          aria-label="Environment"
          class="w-48"
        />
        <div v-if="isAdmin" class="ms-auto flex flex-wrap items-center gap-2">
          <UButton label="Add variable" icon="i-lucide-plus" size="sm" @click="openAdd" />
          <UButton
            label="Import"
            icon="i-lucide-upload"
            size="sm"
            color="neutral"
            variant="outline"
            @click="importOpen = true"
          />
          <UButton
            label="New environment"
            icon="i-lucide-layers"
            size="sm"
            color="neutral"
            variant="outline"
            @click="createEnvOpen = true"
          />
          <UButton
            label="Delete environment"
            icon="i-lucide-trash-2"
            size="sm"
            color="error"
            variant="ghost"
            @click="deleteEnvOpen = true"
          />
        </div>
      </div>

      <UAlert
        v-if="variablesError"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Could not load variables"
        description="The server did not answer."
      >
        <template #actions>
          <UButton color="error" variant="outline" label="Retry" @click="refreshVariables()" />
        </template>
      </UAlert>

      <EmptyState
        v-else-if="rows.length === 0"
        icon="i-lucide-braces"
        title="No variables yet"
        description="Add a variable, or import a .tfvars file or a JSON object."
      />

      <UTable v-else :data="rows" :columns="columns" class="rounded-lg border border-default">
        <template #name-cell="{ row }">
          <span class="font-mono text-sm" translate="no">{{ row.original.name }}</span>
        </template>
        <template #status-cell="{ row }">
          <UBadge
            v-if="row.original.status"
            :color="statusColor[row.original.status]"
            variant="subtle"
            :label="row.original.status"
          />
        </template>
        <template #value-cell="{ row }">
          <span v-if="!row.original.stored" class="text-muted">Not set</span>
          <span v-else-if="row.original.sensitive" class="text-muted" aria-label="Hidden value">
            ••••••
          </span>
          <code
            v-else-if="row.original.value !== undefined"
            class="break-all text-xs"
            translate="no"
            >{{ formatValue(row.original.value) }}</code
          >
        </template>
        <template #description-cell="{ row }">
          <span class="text-sm text-muted">{{ row.original.description }}</span>
        </template>
        <template #updatedAt-cell="{ row }">
          <span v-if="row.original.updatedAt" class="text-sm text-muted tabular">
            <ClientOnly fallback="—">{{ relativeTime(row.original.updatedAt) }}</ClientOnly>
          </span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-pencil"
              :aria-label="`Edit ${row.original.name}`"
              @click="openEdit(row.original)"
            />
            <UButton
              v-if="row.original.stored"
              color="error"
              variant="ghost"
              size="xs"
              icon="i-lucide-trash-2"
              :aria-label="`Delete ${row.original.name}`"
              @click="pendingDelete = row.original.name"
            />
          </div>
        </template>
      </UTable>

      <details class="rounded-lg border border-default px-4 py-3 text-sm">
        <summary class="cursor-pointer font-medium">Use in CI</summary>
        <p class="mt-3 text-muted text-pretty">
          Download this environment as a tfvars file, using a token with Read Variables.
        </p>
        <pre
          class="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs [overscroll-behavior-x:contain]"
          translate="no"
        ><code>{{ curl }}</code></pre>
      </details>
    </template>

    <EnvironmentCreateModal
      v-model:open="createEnvOpen"
      :project-id="projectId"
      @created="onEnvironmentCreated"
    />

    <template v-if="envId">
      <VariableEditModal
        v-model:open="editOpen"
        :environment-id="envId"
        :existing="editing"
        @saved="refreshVariables()"
      />
      <VariableImportModal
        v-model:open="importOpen"
        :environment-id="envId"
        @imported="refreshVariables()"
      />
    </template>

    <UModal
      :open="pendingDelete !== null"
      title="Delete Variable?"
      :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
      @update:open="
        (value) => {
          if (!value) {
            pendingDelete = null
            deleteError = null
          }
        }
      "
    >
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-muted text-pretty">
            <span class="font-mono" translate="no">{{ pendingDelete }}</span> will no longer be
            delivered to CI. This cannot be undone.
          </p>
          <div aria-live="polite">
            <UAlert
              v-if="deleteError"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :description="deleteError"
            />
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="pendingDelete = null" />
          <UButton
            color="error"
            :loading="deleting"
            :label="deleting ? 'Deleting…' : 'Delete'"
            @click="removeVariable"
          />
        </div>
      </template>
    </UModal>

    <UModal
      :open="deleteEnvOpen"
      title="Delete Environment?"
      :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
      @update:open="
        (value) => {
          deleteEnvOpen = value
          if (!value) deleteError = null
        }
      "
    >
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-muted text-pretty">
            This deletes <span class="font-mono" translate="no">{{ env?.slug }}</span> and its
            {{ rows.filter((r) => r.stored).length }} stored variables. This cannot be undone.
          </p>
          <div aria-live="polite">
            <UAlert
              v-if="deleteError"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :description="deleteError"
            />
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="deleteEnvOpen = false" />
          <UButton
            color="error"
            :loading="deleting"
            :label="deleting ? 'Deleting…' : 'Delete environment'"
            @click="removeEnvironment"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
