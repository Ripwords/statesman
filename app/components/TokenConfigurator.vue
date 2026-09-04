<script setup lang="ts">
import type { FormErrorEvent, FormSubmitEvent } from '@nuxt/ui'
import { tokenConfigSchema, type StateAction, type TokenConfig } from '~~/shared/schemas/token'

const emit = defineEmits<{ created: [{ id: string, key: string, name: string }] }>()

const { data: projects } = await useFetch('/api/ui/projects')

const state = reactive<Partial<TokenConfig>>({
  name: undefined,
  actions: ['read', 'write', 'lock'],
  scope: { kind: 'projects', projects: [] },
  expiresInDays: 90
})

const scopeKind = computed<'all' | 'projects'>({
  get: () => state.scope?.kind ?? 'projects',
  set: (kind) => {
    state.scope = kind === 'all' ? { kind: 'all' } : { kind: 'projects', projects: [] }
  }
})

const selectedProjects = computed<string[]>({
  get: () => (state.scope?.kind === 'projects' ? state.scope.projects : []),
  set: (chosen) => { state.scope = { kind: 'projects', projects: chosen } }
})

/**
 * Rate limiting is live (CARRY-FORWARD §3). Left off, the token inherits the
 * server's 120 requests per 60 seconds; switched on, these two fields override
 * it. There is no way to issue an unmetered token, which is deliberate.
 */
const limitRate = ref(false)
watch(limitRate, (on) => {
  state.rateLimitMax = on ? 60 : undefined
  state.rateLimitWindowSeconds = on ? 60 : undefined
})

const actionOptions: { label: string, value: StateAction, description: string }[] = [
  { label: 'Read State', value: 'read', description: 'Required for terraform plan' },
  { label: 'Write State', value: 'write', description: 'Required for terraform apply' },
  { label: 'Lock State', value: 'lock', description: 'Required for any apply that locks' },
  { label: 'Delete State', value: 'delete', description: 'Required for terraform destroy' }
]

const projectOptions = computed(() =>
  (projects.value ?? []).map((p) => `${p.org}/${p.slug}`)
)

const pending = ref(false)
const formError = ref<string | null>(null)

async function onSubmit(event: FormSubmitEvent<TokenConfig>) {
  pending.value = true
  formError.value = null
  try {
    const created = await $fetch('/api/ui/tokens', { method: 'POST', body: event.data })
    emit('created', created)
  } catch {
    formError.value = 'Could not create the token. Check the fields above and try again.'
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
  <UForm
    :schema="tokenConfigSchema"
    :state="state"
    class="space-y-6"
    @submit="onSubmit"
    @error="onError"
  >
    <UFormField
      label="Name"
      name="name"
      description="Identifies this token in the list. Name it after where it will run."
      required
    >
      <UInput
        v-model="state.name"
        name="token-name"
        autocomplete="off"
        autocapitalize="none"
        :spellcheck="false"
        placeholder="ci-prod-deploy…"
        class="w-full"
      />
    </UFormField>

    <UFormField label="Allowed Operations" name="actions" required>
      <UCheckboxGroup v-model="state.actions" :items="actionOptions" />
    </UFormField>

    <UFormField label="Project Scope" name="scope">
      <URadioGroup
        v-model="scopeKind"
        :items="[
          {
            label: 'Specific Projects',
            value: 'projects',
            description: 'Recommended. A leaked token reaches only these.'
          },
          {
            label: 'All My Projects',
            value: 'all',
            description: 'Convenient, but a leak exposes every project.'
          }
        ]"
      />
    </UFormField>

    <UFormField
      v-if="scopeKind === 'projects'"
      label="Projects"
      name="scope.projects"
      description="Pick at least one."
      required
    >
      <USelectMenu
        v-model="selectedProjects"
        multiple
        :items="projectOptions"
        placeholder="Choose projects…"
        class="w-full"
      />
    </UFormField>

    <UFormField
      label="Expires After"
      name="expiresInDays"
      description="Days, up to 365. Leave empty for a token that never expires."
    >
      <UInputNumber v-model="state.expiresInDays" :min="1" :max="365" class="w-full" />
    </UFormField>

    <div class="space-y-3">
      <USwitch v-model="limitRate" label="Set a Custom Rate Limit" />
      <div v-if="limitRate" class="flex flex-wrap gap-3">
        <UFormField label="Requests" name="rateLimitMax" class="w-32">
          <UInputNumber v-model="state.rateLimitMax" :min="1" class="w-full" />
        </UFormField>
        <UFormField label="Per Seconds" name="rateLimitWindowSeconds" class="w-32">
          <UInputNumber v-model="state.rateLimitWindowSeconds" :min="1" class="w-full" />
        </UFormField>
      </div>
      <p v-else class="text-sm text-muted text-pretty">
        This token will use the server default of 120 requests per 60 seconds.
      </p>
    </div>

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
      :label="pending ? 'Creating Token…' : 'Create Token'"
      icon="i-lucide-key-round"
    />
  </UForm>
</template>
