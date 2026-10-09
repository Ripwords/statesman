<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import { statusMessageOf } from '~/utils/status-message'
import type { EffectiveRole } from '~~/shared/project-permissions'
import type { ProjectRole } from '~~/shared/schemas/project-role'

const props = defineProps<{ projectId: string; role: EffectiveRole | null | undefined }>()

const { can } = useProjectRole(toRef(props, 'role'))
const canManage = computed(() => can('member:manage'))

const {
  data,
  error: loadError,
  refresh
} = await useFetch(() => `/api/ui/projects/${props.projectId}/members`)
type Member = NonNullable<typeof data.value>['members'][number]

const members = computed(() => data.value?.members ?? [])
const ownerCount = computed(() => data.value?.ownerCount ?? 0)

const roleOptions: Array<{ label: string; value: ProjectRole }> = [
  { label: 'Viewer', value: 'viewer' },
  { label: 'Editor', value: 'editor' },
  { label: 'Owner', value: 'owner' }
]

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

const columns = computed<TableColumn<Member>[]>(() => [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'email', header: 'Email' },
  { accessorKey: 'role', header: 'Role' },
  { accessorKey: 'addedAt', header: 'Added' },
  ...(canManage.value
    ? [{ id: 'actions', header: () => h('span', { class: 'sr-only' }, 'Actions') }]
    : [])
])

const adding = ref(false)
const removing = ref<Member | null>(null)
const busyId = ref<string | null>(null)
const actionError = ref<string | null>(null)

async function changeRole(row: Member, next: ProjectRole) {
  if (row.role === next) return
  busyId.value = row.userId
  actionError.value = null
  try {
    await $fetch(`/api/ui/projects/${props.projectId}/members/${row.userId}`, {
      method: 'PATCH',
      body: { role: next }
    })
  } catch (error) {
    actionError.value = statusMessageOf(
      error,
      `Could not change the role for ${row.email}. Check that you are still signed in, then try again.`
    )
  } finally {
    // Reload either way, so the select never keeps a role the server refused.
    await refresh()
    busyId.value = null
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="max-w-prose text-sm text-muted text-pretty">
        Viewers read state, history and diffs. Editors also edit variables and unlock state. Owners
        also manage members, environments and tokens.
      </p>
      <ProjectOnly :role="role" permission="member:manage">
        <UButton label="Add Member" icon="i-lucide-user-plus" size="sm" @click="adding = true" />
      </ProjectOnly>
    </div>

    <div aria-live="polite">
      <UAlert
        v-if="actionError"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="actionError"
        :close="true"
        @update:open="actionError = null"
      />
    </div>

    <UAlert
      v-if="loadError"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Could Not Load Members"
      :description="statusMessageOf(loadError, 'The server did not answer.')"
    >
      <template #actions>
        <UButton color="error" variant="outline" label="Retry" @click="refresh()" />
      </template>
    </UAlert>

    <UTable v-else :data="members" :columns="columns" class="rounded-lg border border-default">
      <template #name-cell="{ row }">
        <span class="font-medium">{{ row.original.name }}</span>
      </template>
      <template #email-cell="{ row }">
        <span class="text-sm text-muted" translate="no">{{ row.original.email }}</span>
      </template>
      <template #role-cell="{ row }">
        <USelect
          v-if="canManage"
          :model-value="row.original.role"
          :items="roleOptions"
          value-key="value"
          :disabled="busyId === row.original.userId"
          class="w-32"
          :aria-label="`Role for ${row.original.email}`"
          @update:model-value="(next: ProjectRole) => changeRole(row.original, next)"
        />
        <UBadge
          v-else
          :color="ROLE_COLOR[row.original.role]"
          variant="subtle"
          :label="row.original.role"
        />
      </template>
      <template #addedAt-cell="{ row }">
        <span class="text-sm text-muted tabular">
          <ClientOnly fallback="—">{{ when.format(new Date(row.original.addedAt)) }}</ClientOnly>
        </span>
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end">
          <UButton
            color="error"
            variant="ghost"
            size="xs"
            icon="i-lucide-user-minus"
            :aria-label="`Remove ${row.original.email}`"
            @click="removing = row.original"
          />
        </div>
      </template>
    </UTable>

    <MemberAddModal v-model:open="adding" :project-id="projectId" @added="refresh()" />
    <MemberRemoveModal
      :project-id="projectId"
      :member="removing"
      :last-owner="ownerCount === 1 && removing?.role === 'owner'"
      @removed="refresh()"
      @close="removing = null"
    />
  </div>
</template>
