<script setup lang="ts">
import { statusMessageOf } from '~/utils/status-message'
import type { ProjectRow } from '~/utils/project-row'

const props = defineProps<{ project: ProjectRow }>()
const open = defineModel<boolean>('open', { required: true })

const address = computed(() => `${props.project.org}/${props.project.slug}`)
const typed = ref('')
const pending = ref(false)
const error = ref<string | null>(null)

watch(open, (isOpen) => {
  if (isOpen) return
  typed.value = ''
  error.value = null
})

async function confirm() {
  if (typed.value !== address.value) return
  pending.value = true
  error.value = null
  try {
    await $fetch(`/api/ui/projects/${props.project.id}`, { method: 'DELETE' })
    open.value = false
    await navigateTo({ path: '/', query: { deleted: address.value } })
  } catch (e) {
    error.value = statusMessageOf(e, 'Could not delete the project. Try again.')
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Delete This Project?"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
  >
    <template #body>
      <form id="project-delete" class="space-y-4" @submit.prevent="confirm">
        <p class="text-sm text-muted text-pretty">
          This permanently removes every state version, environment, variable and member of
          <code class="text-xs" translate="no">{{ address }}</code
          >, and deletes its encrypted state from storage. It cannot be undone.
        </p>
        <UFormField :label="`Type ${address} to confirm`" name="confirm-address">
          <UInput
            v-model="typed"
            autocomplete="off"
            autocapitalize="none"
            :spellcheck="false"
            class="w-full font-mono"
            translate="no"
          />
        </UFormField>
        <div aria-live="polite">
          <UAlert
            v-if="error"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="error"
          />
        </div>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton
          type="submit"
          form="project-delete"
          color="error"
          icon="i-lucide-trash-2"
          :disabled="typed !== address"
          :loading="pending"
          label="Delete Project"
        />
      </div>
    </template>
  </UModal>
</template>
