<script setup lang="ts">
import { statusMessageOf } from '~/utils/status-message'

type Target = { userId: string; email: string; role: string }

const props = defineProps<{ projectId: string; member: Target | null; lastOwner: boolean }>()
const emit = defineEmits<{ removed: []; close: [] }>()

const pending = ref(false)
const failure = ref<string | null>(null)

async function remove() {
  if (!props.member) return
  pending.value = true
  failure.value = null
  try {
    await $fetch(`/api/ui/projects/${props.projectId}/members/${props.member.userId}`, {
      method: 'DELETE'
    })
    emit('removed')
    emit('close')
  } catch (error) {
    failure.value = statusMessageOf(
      error,
      'Could not remove the member. Check that you are still signed in, then try again.'
    )
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <UModal
    :open="member !== null"
    title="Remove This Member?"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
    @update:open="
      (value) => {
        if (!value) {
          failure = null
          emit('close')
        }
      }
    "
  >
    <template #body>
      <div class="space-y-3">
        <p class="text-sm text-muted text-pretty">
          <span class="break-all font-medium" translate="no">{{ member?.email }}</span> will lose
          access to this project straight away. Their existing tokens for it stop working.
        </p>
        <UAlert
          v-if="lastOwner"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          description="This project will have no owners. Only an admin can manage its members after this."
        />
        <div aria-live="polite">
          <UAlert
            v-if="failure"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="failure"
          />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="emit('close')" />
        <UButton
          color="error"
          :loading="pending"
          :label="pending ? 'Removing…' : 'Remove Member'"
          @click="remove"
        />
      </div>
    </template>
  </UModal>
</template>
