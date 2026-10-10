<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'
import { statusMessageOf } from '~/utils/status-message'
import type { ProjectRow } from '~/utils/project-row'
import { updateProjectSchema } from '~~/shared/schemas/project'

const props = defineProps<{ project: ProjectRow }>()
// The page owns the list this row came from; it refetches on `changed`.
const emit = defineEmits<{ changed: [] }>()

const { can } = useProjectRole(computed(() => props.project.myRole))
const isAdmin = computed(() => props.project.myRole === 'admin')

// ── General ────────────────────────────────────────────────────────────────
const generalSchema = updateProjectSchema.pick({ name: true, description: true }).required()
const general = reactive<{ name: string; description: string }>({ name: '', description: '' })
function resetGeneral() {
  general.name = props.project.name
  general.description = props.project.description ?? ''
}
resetGeneral()
watch(() => [props.project.name, props.project.description], resetGeneral)

const savingGeneral = ref(false)
const generalError = ref<string | null>(null)
const generalSaved = ref(false)

async function saveGeneral(event: FormSubmitEvent<z.output<typeof generalSchema>>) {
  savingGeneral.value = true
  generalError.value = null
  generalSaved.value = false
  try {
    await $fetch(`/api/ui/projects/${props.project.id}`, { method: 'PATCH', body: event.data })
    generalSaved.value = true
    emit('changed')
  } catch (e) {
    generalError.value = statusMessageOf(e, 'Could not save. Try again.')
  } finally {
    savingGeneral.value = false
  }
}

// ── Backend configuration ──────────────────────────────────────────────────
const origin = useRequestURL().origin
const snippet = computed(() =>
  backendSnippet({ origin, org: props.project.org, project: props.project.slug })
)
const copied = ref(false)
const copyError = ref<string | null>(null)
let resetTimer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  try {
    await navigator.clipboard.writeText(snippet.value)
    copyError.value = null
    copied.value = true
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    copied.value = false
    copyError.value =
      'The clipboard is not available here. Select the block above and copy it manually.'
  }
}
onBeforeUnmount(() => {
  if (resetTimer) clearTimeout(resetTimer)
})

// ── Retention ──────────────────────────────────────────────────────────────
// Text, not numbers: a blank field is meaningful ("use the default"), and
// v-model.number turns blank into '' rather than null.
const wholeOrBlank = z
  .string()
  .trim()
  .regex(/^([1-9]\d{0,4}|100000)?$/, 'Use a whole number from 1 to 100000, or leave it blank.')
const retentionSchema = z.object({ versions: wholeOrBlank, days: wholeOrBlank })
type RetentionInput = z.infer<typeof retentionSchema>
const retentionState = reactive<RetentionInput>({ versions: '', days: '' })
function resetRetention() {
  const r = props.project.retention
  retentionState.versions = r.source.versions === 'project' ? String(r.keepVersions) : ''
  retentionState.days = r.source.days === 'project' ? String(r.keepDays) : ''
}
resetRetention()
watch(() => props.project.retention, resetRetention, { deep: true })

// The deployment default is what a blank field falls back to. When the
// project overrides a value the list no longer carries the default, so the
// placeholder says only "Default".
const defaultHint = (source: 'default' | 'project', value: number) =>
  source === 'default' ? `Default (${value})` : 'Default'

const savingRetention = ref(false)
const retentionError = ref<string | null>(null)
const retentionSaved = ref(false)

async function saveRetention(event: FormSubmitEvent<RetentionInput>) {
  const toValue = (s: string) => (s.trim() === '' ? null : Number(s))
  savingRetention.value = true
  retentionError.value = null
  retentionSaved.value = false
  try {
    await $fetch(`/api/ui/projects/${props.project.id}`, {
      method: 'PATCH',
      body: {
        retentionKeepVersions: toValue(event.data.versions),
        retentionKeepDays: toValue(event.data.days)
      }
    })
    retentionSaved.value = true
    emit('changed')
  } catch (e) {
    retentionError.value = statusMessageOf(e, 'Could not save retention. Try again.')
  } finally {
    savingRetention.value = false
  }
}

const sourceLabel = (source: 'default' | 'project') =>
  source === 'default' ? 'deployment default' : 'this project'

// ── Danger zone ────────────────────────────────────────────────────────────
const archiveOpen = ref(false)
const deleteOpen = ref(false)
</script>

<template>
  <div class="space-y-8">
    <section aria-labelledby="settings-general" class="space-y-4">
      <h2 id="settings-general" class="text-lg font-semibold">General</h2>

      <UForm
        v-if="can('project:update')"
        :schema="generalSchema"
        :state="general"
        class="max-w-xl space-y-4"
        @submit="saveGeneral"
      >
        <UFormField
          label="Display Name"
          name="name"
          :description="`Shown in the dashboard. The address stays ${project.org}/${project.slug}.`"
          required
        >
          <UInput v-model="general.name" autocomplete="off" class="w-full" />
        </UFormField>
        <UFormField label="Description" name="description" hint="Optional">
          <UTextarea v-model="general.description" :rows="3" autoresize class="w-full" />
        </UFormField>
        <div aria-live="polite">
          <UAlert
            v-if="generalError"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="generalError"
          />
          <p v-else-if="generalSaved" class="text-sm text-success">Saved.</p>
        </div>
        <UButton type="submit" :loading="savingGeneral" label="Save" />
      </UForm>

      <dl v-else class="grid max-w-xl gap-3 text-sm">
        <div>
          <dt class="text-muted">Display name</dt>
          <dd>{{ project.name }}</dd>
        </div>
        <div>
          <dt class="text-muted">Description</dt>
          <dd class="whitespace-pre-line text-pretty">{{ project.description ?? '—' }}</dd>
        </div>
      </dl>
    </section>

    <section aria-labelledby="settings-backend" class="space-y-3">
      <div class="flex max-w-3xl items-center justify-between gap-2">
        <h2 id="settings-backend" class="text-lg font-semibold">Backend Configuration</h2>
        <UButton
          size="xs"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          :color="copied ? 'success' : 'neutral'"
          variant="outline"
          :label="copied ? 'Copied' : 'Copy'"
          @click="copy"
        />
      </div>
      <pre
        class="max-w-3xl overflow-x-auto rounded-lg bg-muted p-3 text-xs [overscroll-behavior-x:contain]"
        translate="no"
      ><code>{{ snippet }}</code></pre>
      <div aria-live="polite">
        <p v-if="copyError" class="text-sm text-error text-pretty">{{ copyError }}</p>
      </div>
      <p class="max-w-3xl text-sm text-muted text-pretty">
        Authenticate with a token rather than putting one in the file:
        <code class="text-xs" translate="no">export TF_HTTP_PASSWORD='sm_…'</code>.
      </p>
    </section>

    <section aria-labelledby="settings-retention" class="space-y-3">
      <h2 id="settings-retention" class="text-lg font-semibold">Retention</h2>
      <p class="max-w-xl text-sm text-muted text-pretty">
        Older versions are pruned once there are more than the versions kept and they are older than
        the days kept. The current version is never pruned.
      </p>

      <UForm
        v-if="isAdmin"
        :schema="retentionSchema"
        :state="retentionState"
        class="max-w-xl space-y-4"
        @submit="saveRetention"
      >
        <div class="flex flex-wrap gap-4">
          <UFormField label="Versions kept" name="versions" class="w-44">
            <UInput
              v-model="retentionState.versions"
              inputmode="numeric"
              autocomplete="off"
              :placeholder="
                defaultHint(project.retention.source.versions, project.retention.keepVersions)
              "
              class="w-full tabular"
            />
          </UFormField>
          <UFormField label="Days kept" name="days" class="w-44">
            <UInput
              v-model="retentionState.days"
              inputmode="numeric"
              autocomplete="off"
              :placeholder="defaultHint(project.retention.source.days, project.retention.keepDays)"
              class="w-full tabular"
            />
          </UFormField>
        </div>
        <p class="text-sm text-muted">Leave a field blank to use the deployment default.</p>
        <div aria-live="polite">
          <UAlert
            v-if="retentionError"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="retentionError"
          />
          <p v-else-if="retentionSaved" class="text-sm text-success">Saved.</p>
        </div>
        <UButton type="submit" :loading="savingRetention" label="Save Retention" />
      </UForm>

      <dl v-else class="grid max-w-xl gap-3 text-sm tabular">
        <div>
          <dt class="text-muted">Versions kept</dt>
          <dd>
            {{ project.retention.keepVersions }}
            <span class="text-muted">({{ sourceLabel(project.retention.source.versions) }})</span>
          </dd>
        </div>
        <div>
          <dt class="text-muted">Days kept</dt>
          <dd>
            {{ project.retention.keepDays }}
            <span class="text-muted">({{ sourceLabel(project.retention.source.days) }})</span>
          </dd>
        </div>
      </dl>
    </section>

    <section
      v-if="isAdmin"
      aria-labelledby="settings-danger"
      class="max-w-3xl space-y-4 rounded-lg border border-error/40 p-4"
    >
      <h2 id="settings-danger" class="text-lg font-semibold text-error">Danger Zone</h2>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0 flex-1 basis-64">
          <p class="font-medium">{{ project.archived ? 'Unarchive' : 'Archive' }}</p>
          <p class="text-sm text-muted text-pretty">
            {{
              project.archived
                ? 'Return the project to the list and accept Terraform writes again.'
                : 'Make the project read-only and hide it from the list. Reversible.'
            }}
          </p>
        </div>
        <UButton
          color="warning"
          variant="outline"
          :icon="project.archived ? 'i-lucide-archive-restore' : 'i-lucide-archive'"
          :label="project.archived ? 'Unarchive' : 'Archive'"
          @click="archiveOpen = true"
        />
      </div>

      <USeparator />

      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0 flex-1 basis-64">
          <p class="font-medium">Delete</p>
          <p class="text-sm text-muted text-pretty">
            {{
              project.archived
                ? 'Permanently remove the project, its history and its stored state.'
                : 'Archive the project first.'
            }}
          </p>
        </div>
        <UButton
          color="error"
          variant="outline"
          icon="i-lucide-trash-2"
          label="Delete"
          :disabled="!project.archived"
          @click="deleteOpen = true"
        />
      </div>
    </section>

    <ProjectArchiveModal v-model:open="archiveOpen" :project="project" @done="emit('changed')" />
    <ProjectDeleteModal v-model:open="deleteOpen" :project="project" />
  </div>
</template>
