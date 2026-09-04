<script setup lang="ts">
import type { FormErrorEvent, FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'

definePageMeta({ layout: false })
useHead({ title: 'Sign In · statesman' })

const schema = z.object({
  email: z.email('Enter a valid email address, like you@example.com'),
  password: z.string().min(8, 'Passwords are at least 8 characters. Check for a typo.')
})
type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({ email: undefined, password: undefined })
const pending = ref(false)
const formError = ref<string | null>(null)
const route = useRoute()
const { signIn } = useAuth()

/** Only same-origin paths, so `?redirect=` cannot bounce anyone off-site. */
function safeRedirect(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/'
}

async function onSubmit(event: FormSubmitEvent<Schema>) {
  pending.value = true
  formError.value = null
  const { error } = await signIn(event.data)
  pending.value = false
  if (error) {
    formError.value = 'That email and password did not match. Check both and try again.'
    return
  }
  await navigateTo(safeRedirect(route.query.redirect))
}

function onError(event: FormErrorEvent) {
  const id = event.errors[0]?.id
  if (id) document.getElementById(id)?.focus()
}
</script>

<template>
  <div
    class="grid min-h-dvh touch-manipulation place-items-center bg-muted px-4 py-8 [-webkit-tap-highlight-color:transparent]"
  >
    <UCard class="w-full max-w-sm">
      <template #header>
        <h1 class="text-lg font-semibold tracking-tight text-balance">
          Sign In to <span translate="no">statesman</span>
        </h1>
      </template>

      <UForm
        :schema="schema"
        :state="state"
        class="space-y-4"
        @submit="onSubmit"
        @error="onError"
      >
        <UFormField label="Email" name="email" required>
          <UInput
            v-model="state.email"
            type="email"
            name="email"
            autocomplete="username"
            autocapitalize="none"
            :spellcheck="false"
            placeholder="you@example.com"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput
            v-model="state.password"
            type="password"
            name="password"
            autocomplete="current-password"
            :spellcheck="false"
            class="w-full"
          />
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
          block
          :loading="pending"
          :label="pending ? 'Signing In…' : 'Sign In'"
        />
      </UForm>
    </UCard>
  </div>
</template>
