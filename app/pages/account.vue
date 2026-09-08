<script setup lang="ts">
import type { FormErrorEvent, FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'

definePageMeta({ layout: 'dashboard' })
useHead({ title: 'Account · statesman' })

const { user, role } = useAuth()

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: z.string().min(8, 'Passwords are at least 8 characters.'),
    confirmPassword: z.string().min(1, 'Type the new password again.')
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: 'These two do not match. Check both and try again.',
    path: ['confirmPassword']
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    message: 'This is your current password. Choose a different one.',
    path: ['newPassword']
  })
type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({
  currentPassword: undefined,
  newPassword: undefined,
  confirmPassword: undefined
})
const pending = ref(false)
const formError = ref<string | null>(null)
const done = ref(false)

async function onSubmit(event: FormSubmitEvent<Schema>) {
  pending.value = true
  formError.value = null
  done.value = false

  try {
    const { error } = await useAuthClient().changePassword({
      currentPassword: event.data.currentPassword,
      newPassword: event.data.newPassword,
      // Anything else signed in as this account was signed in under the
      // password being replaced. Leaving those alive is the whole reason a
      // stolen session outlives a password change.
      revokeOtherSessions: true
    })
    if (error) {
      formError.value =
        'That current password did not match. Check it and try again — the new password was not set.'
      return
    }
    done.value = true
    state.currentPassword = undefined
    state.newPassword = undefined
    state.confirmPassword = undefined
  } catch {
    // The client throws rather than returning `error` when the request never
    // completes, so this is transport, not a rejected password.
    formError.value =
      'We could not reach the server, so nothing was changed. Check your connection, then try again.'
  } finally {
    pending.value = false
  }
}

function onError(event: FormErrorEvent) {
  const id = event.errors[0]?.id
  if (id) document.getElementById(id)?.focus()
}
</script>

<template>
  <div class="max-w-md space-y-6">
    <h1 class="scroll-mt-24 text-xl font-semibold tracking-tight text-balance">Account</h1>

    <dl class="grid gap-1 text-sm">
      <div class="flex min-w-0 gap-2">
        <dt class="text-muted">Signed in as</dt>
        <dd class="min-w-0 truncate font-medium">{{ user?.email }}</dd>
      </div>
      <div class="flex min-w-0 gap-2">
        <dt class="text-muted">Role</dt>
        <dd class="font-medium">{{ role === 'admin' ? 'Admin' : 'Member' }}</dd>
      </div>
    </dl>

    <UCard>
      <template #header>
        <h2 class="font-semibold tracking-tight text-balance">Change Password</h2>
      </template>

      <div aria-live="polite">
        <UAlert
          v-if="done"
          class="mb-4"
          color="success"
          variant="subtle"
          icon="i-lucide-check"
          description="Password changed. Every other session was signed out; this one stays signed in."
          :close="true"
          @update:open="done = false"
        />
        <UAlert
          v-else-if="formError"
          class="mb-4"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="formError"
        />
      </div>

      <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit" @error="onError">
        <UFormField label="Current Password" name="currentPassword" required>
          <UInput
            v-model="state.currentPassword"
            type="password"
            name="currentPassword"
            autocomplete="current-password"
            spellcheck="false"
            class="w-full"
          />
        </UFormField>

        <UFormField label="New Password" name="newPassword" required hint="At least 8 characters">
          <UInput
            v-model="state.newPassword"
            type="password"
            name="newPassword"
            autocomplete="new-password"
            spellcheck="false"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Confirm New Password" name="confirmPassword" required>
          <UInput
            v-model="state.confirmPassword"
            type="password"
            name="confirmPassword"
            autocomplete="new-password"
            spellcheck="false"
            class="w-full"
          />
        </UFormField>

        <!-- Enabled until the request starts, so a slow first click is not lost. -->
        <UButton
          type="submit"
          :loading="pending"
          :label="pending ? 'Changing Password…' : 'Change Password'"
        />
      </UForm>
    </UCard>

    <p class="max-w-prose text-sm text-muted text-pretty">
      Lost your password entirely? An admin can reset it from Users. There is no email recovery —
      statesman sends no mail.
    </p>
  </div>
</template>
