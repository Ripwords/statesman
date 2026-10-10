<script setup lang="ts">
import type { FormErrorEvent, FormSubmitEvent } from '@nuxt/ui'
import { statusMessageOf } from '~/utils/status-message'
import { createUserSchema, type CreateUserInput, type UserRole } from '~~/shared/schemas/user'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [account: { email: string; password: string }] }>()

const roleOptions: Array<{ label: string; value: UserRole; description: string }> = [
  {
    label: 'Member',
    value: 'member',
    description: 'Reaches only the projects they are added to'
  },
  { label: 'Admin', value: 'admin', description: 'Manages accounts and reaches every project' }
]

const state = reactive<{ email?: string; name?: string; role: UserRole }>({
  email: undefined,
  name: undefined,
  role: 'member'
})
const pending = ref(false)
const formError = ref<string | null>(null)

async function onSubmit(event: FormSubmitEvent<CreateUserInput>) {
  pending.value = true
  formError.value = null
  try {
    const created = await $fetch('/api/ui/users', { method: 'POST', body: event.data })
    open.value = false
    emit('created', { email: created.email, password: created.password })
  } catch (error) {
    formError.value = statusMessageOf(
      error,
      'Could not create the account. Check that you are still signed in, then try again.'
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
  state.name = undefined
  state.role = 'member'
})
</script>

<template>
  <UModal
    v-model:open="open"
    title="New User"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
  >
    <template #body>
      <UForm
        :schema="createUserSchema"
        :state="state"
        class="space-y-6"
        @submit="onSubmit"
        @error="onError"
      >
        <UFormField label="Email" name="email" required>
          <UInput
            v-model="state.email"
            name="new-user-email"
            type="email"
            autocomplete="off"
            autocapitalize="none"
            :spellcheck="false"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Name" name="name" hint="Optional">
          <UInput v-model="state.name" name="new-user-name" autocomplete="off" class="w-full" />
        </UFormField>

        <UFormField label="Role" name="role">
          <URadioGroup v-model="state.role" :items="roleOptions" value-key="value" />
        </UFormField>

        <p class="text-sm text-muted text-pretty">
          A password is generated and shown once, for you to pass on. Add a member to projects from
          each project’s Members tab.
        </p>

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
          :label="pending ? 'Creating Account…' : 'Create Account'"
          icon="i-lucide-user-plus"
        />
      </UForm>
    </template>
  </UModal>
</template>
