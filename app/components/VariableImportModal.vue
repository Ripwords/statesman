<script setup lang="ts">
import { FetchError } from 'ofetch'
import type { ImportVariablesInput } from '~~/shared/schemas/variable'

const props = defineProps<{ environmentId: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ imported: [] }>()

type Preview = { created: string[]; overwritten: string[] }

const text = ref('')
const preview = ref<Preview | null>(null)
const error = ref<string | null>(null)
const pending = ref(false)

// Editing the text invalidates a preview: what Import sends must be what was
// previewed.
watch(text, () => {
  preview.value = null
  error.value = null
})

watch(open, (isOpen) => {
  if (isOpen) return
  text.value = ''
  preview.value = null
  error.value = null
})

async function onFile(event: Event) {
  const file = event.target instanceof HTMLInputElement ? event.target.files?.[0] : undefined
  if (file) text.value = await file.text()
}

/**
 * Exactly `{ dryRun, values }` or `{ dryRun, hcl }`: the server's schema is
 * strict, so no other key may travel with them.
 */
function bodyFor(dryRun: boolean): ImportVariablesInput {
  const trimmed = text.value.trim()
  if (trimmed.startsWith('{')) {
    return { dryRun, values: JSON.parse(trimmed) }
  }
  return { dryRun, hcl: text.value }
}

async function send(dryRun: boolean) {
  error.value = null
  let body
  try {
    body = bodyFor(dryRun)
  } catch {
    error.value = 'That looks like JSON but does not parse. Check for a missing quote or comma.'
    return
  }
  pending.value = true
  try {
    const result = await $fetch(`/api/ui/environments/${props.environmentId}/variables/import`, {
      method: 'POST',
      body
    })
    if (dryRun) {
      preview.value = result
    } else {
      emit('imported')
      open.value = false
    }
  } catch (e) {
    error.value =
      (e instanceof FetchError ? e.statusMessage : undefined) ??
      'Could not import. Check your connection, then try again.'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Import Variables"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
  >
    <template #body>
      <div class="space-y-4">
        <UFormField
          label="Variables"
          name="import-text"
          description="Paste a JSON object (name to value) or the contents of a .tfvars file."
        >
          <UTextarea
            v-model="text"
            :rows="8"
            autocomplete="off"
            :spellcheck="false"
            placeholder='{"region": "eu-west-1"}'
            class="w-full font-mono"
          />
        </UFormField>

        <div>
          <label for="import-file" class="mb-1 block text-sm font-medium">Or choose a file</label>
          <input
            id="import-file"
            type="file"
            accept=".tfvars,.json"
            class="block w-full text-sm text-muted file:me-3 file:rounded-md file:border file:border-default file:bg-default file:px-3 file:py-1.5 file:text-sm file:text-default"
            @change="onFile"
          />
        </div>

        <div aria-live="polite" class="space-y-3">
          <UAlert
            v-if="error"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="error"
          />
          <div v-if="preview" class="space-y-1 text-sm">
            <p>
              <span class="font-medium">Will create:</span>
              <span translate="no" class="ms-1 font-mono">
                {{ preview.created.length ? preview.created.join(', ') : 'nothing' }}
              </span>
            </p>
            <p>
              <span class="font-medium">Will overwrite:</span>
              <span translate="no" class="ms-1 font-mono">
                {{ preview.overwritten.length ? preview.overwritten.join(', ') : 'nothing' }}
              </span>
            </p>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
          <UButton
            v-if="!preview"
            :disabled="text.trim() === ''"
            :loading="pending"
            color="neutral"
            variant="outline"
            label="Preview"
            @click="send(true)"
          />
          <UButton
            v-else
            :loading="pending"
            :label="pending ? 'Importing…' : 'Import'"
            icon="i-lucide-upload"
            @click="send(false)"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
