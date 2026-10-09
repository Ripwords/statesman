<script setup lang="ts">
import type { FormErrorEvent, FormSubmitEvent } from '@nuxt/ui'
import { FetchError } from 'ofetch'
import { createEnvironmentSchema } from '~~/shared/schemas/variable'

type CreateEnvironmentInput = { slug: string }

const props = defineProps<{ projectId: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [environment: { id: string; slug: string }] }>()

const state = reactive<Partial<CreateEnvironmentInput>>({ slug: 'default' })
const pending = ref(false)
const formError = ref<string | null>(null)

async function onSubmit(event: FormSubmitEvent<CreateEnvironmentInput>) {
  pending.value = true
  formError.value = null
  try {
    const created = await $fetch(`/api/ui/projects/${props.projectId}/environments`, {
      method: 'POST',
      body: { slug: event.data.slug }
    })
    emit('created', { id: created.id, slug: created.slug })
    open.value = false
  } catch (error) {
    const detail = error instanceof FetchError ? error.statusMessage : undefined
    formError.value =
      detail ??
      'Could not create the environment. Check that you are still signed in, then try again.'
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
  state.slug = 'default'
})
</script>

<template>
  <UModal
    v-model:open="open"
    title="New Environment"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
  >
    <template #body>
      <UForm
        :schema="createEnvironmentSchema"
        :state="state"
        class="space-y-6"
        @submit="onSubmit"
        @error="onError"
      >
        <UFormField
          label="Environment Name"
          name="slug"
          description="Lowercase letters, digits and dashes. It becomes the last segment of the address CI downloads variables from."
          required
        >
          <UInput
            v-model="state.slug"
            name="environment-slug"
            autocomplete="off"
            autocapitalize="none"
            :spellcheck="false"
            class="w-full font-mono"
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
          :loading="pending"
          :label="pending ? 'Creating Environment…' : 'Create Environment'"
          icon="i-lucide-plus"
        />
      </UForm>
    </template>
  </UModal>
</template>
