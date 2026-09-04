<script setup lang="ts">
import type { FormErrorEvent, FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'

definePageMeta({ layout: false })
useHead({ title: 'Sign In · statesman', htmlAttrs: { lang: 'en' } })

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

// Set by the route guard when the auth server could not be reached, so the
// page can say so instead of implying the visitor was signed out.
const unreachable = computed(() => route.query.reason === 'unavailable')

async function onSubmit(event: FormSubmitEvent<Schema>) {
  pending.value = true
  formError.value = null
  const result = await signIn(event.data)
  pending.value = false
  if (!result.ok) {
    // A rejected password and an unreachable server need different next steps,
    // so they get different sentences.
    formError.value = result.reason === 'unreachable'
      ? 'We could not reach the sign-in service. Check your connection, then try again.'
      : 'That email and password did not match. Check both and try again.'
    return
  }
  await navigateTo(safeInternalPath(route.query.redirect))
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

      <div v-if="unreachable" class="mb-4">
        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-plug-zap"
          title="Sign-In Service Unreachable"
          description="We could not check whether you were already signed in. Sign in below, or wait a moment and reload."
        />
      </div>

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
            placeholder="you@example.com…"
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
