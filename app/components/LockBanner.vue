<script setup lang="ts">
const props = defineProps<{ projectId: string; who: string | null; since: string | null }>()
const emit = defineEmits<{ released: [] }>()

const open = ref(false)
const pending = ref(false)
const failure = ref<string | null>(null)

// Force-unlock is admin-only server-side. The banner itself still renders for a
// member — knowing the state is locked, and by whom, is exactly what they came
// to find out — but the button that would answer 403 is not offered.
const { isAdmin } = useAuth()

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

async function forceUnlock() {
  pending.value = true
  failure.value = null
  try {
    await $fetch(`/api/ui/projects/${props.projectId}/lock`, { method: 'DELETE' })
    emit('released')
    open.value = false
  } catch {
    failure.value =
      'Could not release the lock. Check that you are still signed in, then try again.'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div>
    <UAlert color="warning" variant="subtle" icon="i-lucide-lock" title="State Is Locked">
      <template #description>
        Held by <span class="break-words" translate="no">{{ who ?? 'an unknown process' }}</span>
        <ClientOnly v-if="since"> since {{ when.format(new Date(since)) }}</ClientOnly
        >. Terraform will refuse to apply until it is released.
      </template>
      <template #actions>
        <UButton
          v-if="isAdmin"
          color="warning"
          variant="outline"
          label="Force Unlock"
          @click="open = true"
        />
      </template>
    </UAlert>

    <UModal
      v-model:open="open"
      title="Force Unlock This State?"
      :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
    >
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-muted text-pretty">
            Force-unlocking while another process is mid-apply can corrupt your state file. Only do
            this when you are certain the holder has died. This action is recorded in the audit log.
          </p>
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
          <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
          <UButton
            color="error"
            :loading="pending"
            :label="pending ? 'Unlocking…' : 'Force Unlock'"
            @click="forceUnlock"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
