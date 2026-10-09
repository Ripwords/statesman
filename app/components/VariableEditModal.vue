<script setup lang="ts">
import type { FormErrorEvent, FormSubmitEvent } from '@nuxt/ui'
import { FetchError } from 'ofetch'
import { z } from 'zod'
import type { VariableRow } from '~~/server/utils/variable-status'
import { setVariableSchema, variableNameSchema } from '~~/shared/schemas/variable'
import { formatValue, parseEditorValue } from '~/utils/variable-value'

const props = defineProps<{
  environmentId: string
  /** Null creates a new variable. */
  existing: VariableRow | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

const schema = z.object({
  name: variableNameSchema,
  description: setVariableSchema.shape.description
})

type FormState = z.output<typeof schema>
const state = reactive<Partial<FormState>>({ name: '', description: '' })
const valueText = ref('')
const jsonMode = ref(false)
const sensitive = ref(true)
const valueError = ref<string | null>(null)
const formError = ref<string | null>(null)
const pending = ref(false)

const keepsSecret = computed(() => props.existing?.sensitive === true)

// Re-seeded on every open so a cancelled edit never leaks into the next one.
// A sensitive value is never sent to the browser, so it never prefills.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    const row = props.existing
    state.name = row?.name ?? ''
    state.description = row?.description ?? ''
    sensitive.value = row?.sensitive ?? true
    valueError.value = null
    formError.value = null
    if (row && !row.sensitive && row.value !== undefined) {
      jsonMode.value = typeof row.value !== 'string'
      valueText.value = formatValue(row.value)
    } else {
      jsonMode.value = false
      valueText.value = ''
    }
  },
  { immediate: true }
)

async function onSubmit(event: FormSubmitEvent<FormState>) {
  valueError.value = null
  formError.value = null
  const omitValue = keepsSecret.value && valueText.value === ''
  let value: ReturnType<typeof parseEditorValue> | null = null
  if (!omitValue) {
    value = parseEditorValue(valueText.value, jsonMode.value ? 'json' : 'string')
    if (!value.ok) {
      valueError.value = value.error
      document.getElementById('variable-value')?.focus()
      return
    }
  }
  pending.value = true
  try {
    // `description` is always sent: the route treats an omitted one as "clear".
    await $fetch(
      `/api/ui/environments/${props.environmentId}/variables/${encodeURIComponent(event.data.name)}`,
      {
        method: 'PUT',
        body: {
          ...(value?.ok ? { value: value.value } : {}),
          sensitive: sensitive.value,
          description: event.data.description ? event.data.description : null
        }
      }
    )
    emit('saved')
    open.value = false
  } catch (error) {
    const detail = error instanceof FetchError ? error.statusMessage : undefined
    formError.value =
      detail ?? 'Could not save the variable. Check your connection, then try again.'
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
  <UModal
    v-model:open="open"
    :title="existing ? 'Edit Variable' : 'Add Variable'"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
  >
    <template #body>
      <UForm :schema="schema" :state="state" class="space-y-5" @submit="onSubmit" @error="onError">
        <UFormField label="Name" name="name" required>
          <UInput
            v-model="state.name"
            name="variable-name"
            autocomplete="off"
            autocapitalize="none"
            :spellcheck="false"
            :disabled="existing !== null"
            placeholder="db_password…"
            class="w-full font-mono"
          />
        </UFormField>

        <UFormField
          label="Value"
          name="value"
          :error="valueError ?? undefined"
          :description="
            jsonMode
              ? 'Parsed as JSON: numbers, booleans, lists and objects.'
              : 'Sent exactly as typed, as a string.'
          "
        >
          <UTextarea
            id="variable-value"
            v-model="valueText"
            :rows="4"
            autocomplete="off"
            :spellcheck="false"
            :placeholder="keepsSecret ? 'Leave empty to keep the current value' : undefined"
            class="w-full font-mono"
          />
        </UFormField>

        <div class="flex flex-wrap gap-x-6 gap-y-3">
          <USwitch v-model="jsonMode" label="JSON" />
          <USwitch v-model="sensitive" label="Sensitive" />
        </div>

        <UFormField label="Description" name="description">
          <UInput
            :model-value="state.description ?? ''"
            name="variable-description"
            class="w-full"
            @update:model-value="state.description = $event"
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

        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
          <UButton
            type="submit"
            :loading="pending"
            :label="pending ? 'Saving…' : 'Save Variable'"
            icon="i-lucide-save"
          />
        </div>
      </UForm>
    </template>
  </UModal>
</template>
