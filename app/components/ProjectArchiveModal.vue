<script setup lang="ts">
import { statusMessageOf } from '~/utils/status-message'
import type { ProjectRow } from '~/utils/project-row'

const props = defineProps<{ project: ProjectRow }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [] }>()

// Read once per opening, so the copy does not flip mid-fade after the list
// refreshes with the new state.
const unarchiving = ref(props.project.archived)
const pending = ref(false)
const error = ref<string | null>(null)

watch(open, (isOpen) => {
  if (!isOpen) return
  unarchiving.value = props.project.archived
  error.value = null
})

async function confirm() {
  pending.value = true
  error.value = null
  try {
    await $fetch(
      `/api/ui/projects/${props.project.id}/${unarchiving.value ? 'unarchive' : 'archive'}`,
      { method: 'POST' }
    )
    open.value = false
    emit('done')
  } catch (e) {
    error.value = statusMessageOf(e, 'Could not change the project. Try again.')
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="unarchiving ? 'Unarchive This Project?' : 'Archive This Project?'"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
  >
    <template #body>
      <div class="space-y-3">
        <p v-if="unarchiving" class="text-sm text-muted text-pretty">
          The project returns to the list, and Terraform can write and lock its state again.
        </p>
        <p v-else class="text-sm text-muted text-pretty">
          Terraform can still read the state, but writes, locks, rollbacks and variable changes are
          refused until an admin unarchives it. The project is hidden from the list unless
          <strong>Show archived</strong> is on. Nothing is deleted.
        </p>
        <div aria-live="polite">
          <UAlert
            v-if="error"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="error"
          />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton
          :color="unarchiving ? 'primary' : 'warning'"
          :icon="unarchiving ? 'i-lucide-archive-restore' : 'i-lucide-archive'"
          :loading="pending"
          :label="unarchiving ? 'Unarchive' : 'Archive'"
          @click="confirm"
        />
      </div>
    </template>
  </UModal>
</template>
