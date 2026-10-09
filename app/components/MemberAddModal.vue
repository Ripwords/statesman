<script setup lang="ts">
import type { FormErrorEvent, FormSubmitEvent } from '@nuxt/ui'
import { statusMessageOf } from '~/utils/status-message'
import { addMemberSchema, type ProjectRole } from '~~/shared/schemas/project-role'

type AddMemberInput = { email: string; role: ProjectRole }

const props = defineProps<{ projectId: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ added: [] }>()

const roleOptions: Array<{ label: string; value: ProjectRole; description: string }> = [
  { label: 'Viewer', value: 'viewer', description: 'Reads state, history and diffs' },
  { label: 'Editor', value: 'editor', description: 'Also edits variables and unlocks state' },
  { label: 'Owner', value: 'owner', description: 'Also manages members, environments and tokens' }
]

const state = reactive<Partial<AddMemberInput>>({ email: undefined, role: 'viewer' })
const pending = ref(false)
const formError = ref<string | null>(null)

async function onSubmit(event: FormSubmitEvent<AddMemberInput>) {
  pending.value = true
  formError.value = null
  try {
    await $fetch(`/api/ui/projects/${props.projectId}/members`, {
      method: 'POST',
      body: event.data
    })
    emit('added')
    open.value = false
  } catch (error) {
    formError.value = statusMessageOf(
      error,
      'Could not add the member. Check that you are still signed in, then try again.'
    )
  } finally {
    pending.value = false
  }
}

function onError(event: FormErrorEvent) {
  const id = event.errors[0]?.id
  if (id) document.getElementById(id)?.focus()
}

watch(open, (isOpen) => {
  if (isOpen) return
  formError.value = null
  state.email = undefined
  state.role = 'viewer'
})
</script>

<template>
  <UModal
    v-model:open="open"
    title="Add Member"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
  >
    <template #body>
      <UForm
        :schema="addMemberSchema"
        :state="state"
        class="space-y-6"
        @submit="onSubmit"
        @error="onError"
      >
        <UFormField
          label="Email"
          name="email"
          description="The account must already exist. An admin creates accounts."
          required
        >
          <UInput
            v-model="state.email"
            name="member-email"
            type="email"
            autocomplete="off"
            autocapitalize="none"
            :spellcheck="false"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Role" name="role">
          <URadioGroup v-model="state.role" :items="roleOptions" value-key="value" />
        </UFormField>

        <div aria-live="polite">
          <UAlert
            v-if="formError"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="formError"
          />
        </div>

        <UButton
          type="submit"
          :loading="pending"
          :label="pending ? 'Adding Member…' : 'Add Member'"
          icon="i-lucide-user-plus"
        />
      </UForm>
    </template>
  </UModal>
</template>
