<script setup lang="ts">
import type { BackendSettings } from '~~/shared/schemas/backend'
import type { EffectiveRole } from '~~/shared/project-permissions'
import { toTfvars } from '~~/shared/hcl/tfvars'
import { statusMessageOf } from '~/utils/status-message'

const props = defineProps<{
  environmentId: string
  backend: BackendSettings | null
  role: EffectiveRole | null | undefined
}>()
const emit = defineEmits<{ changed: [] }>()

const open = ref(false)
const text = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const entries = computed(() =>
  Object.entries(props.backend ?? {}).toSorted(([a], [b]) => a.localeCompare(b))
)

function edit() {
  text.value = props.backend ? toTfvars(props.backend) : ''
  error.value = null
  open.value = true
}

async function save() {
  saving.value = true
  error.value = null
  try {
    await $fetch(`/api/ui/environments/${props.environmentId}/backend`, {
      method: 'PUT',
      body: { hcl: text.value }
    })
    open.value = false
    emit('changed')
  } catch (e) {
    error.value = statusMessageOf(e, 'Could not save. Check your connection, then try again.')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section aria-label="Backend settings" class="rounded-lg border border-default px-4 py-3 text-sm">
    <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
      <div class="min-w-0 flex-1 basis-60">
        <h3 class="font-semibold">Backend settings</h3>
        <p class="text-muted text-pretty">
          Written to the backend file by <code>statesman pull</code>. Not encrypted; never put
          credentials here.
        </p>
      </div>
      <ProjectOnly :role="role" permission="environment:configure">
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          :label="backend ? 'Edit' : 'Add backend settings'"
          @click="edit"
        />
      </ProjectOnly>
    </div>

    <p v-if="!backend" class="mt-3 text-muted text-pretty">
      None. <code>statesman pull</code> writes no backend file for this environment.
    </p>
    <table v-else class="mt-3 w-full table-fixed">
      <tbody>
        <tr v-for="[key, value] in entries" :key="key" class="border-t border-default align-top">
          <td class="w-2/5 py-1.5 pr-4 font-mono break-all" translate="no">{{ key }}</td>
          <td class="py-1.5 font-mono break-all" translate="no">{{ String(value) }}</td>
        </tr>
      </tbody>
    </table>

    <UModal
      v-model:open="open"
      title="Backend settings"
      :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
    >
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-muted text-pretty">
            Paste a backend config file, one <code>name = value</code> per line. Leave it empty to
            remove the settings.
          </p>
          <UTextarea
            v-model="text"
            :rows="8"
            class="w-full"
            :ui="{ base: 'font-mono' }"
            autoresize
            spellcheck="false"
            aria-label="Backend settings file"
          />
          <div aria-live="polite">
            <UAlert
              v-if="error"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :description="error"
            />
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
          <UButton :loading="saving" :label="saving ? 'Saving…' : 'Save'" @click="save" />
        </div>
      </template>
    </UModal>
  </section>
</template>
