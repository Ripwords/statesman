<script setup lang="ts">
import type { FormErrorEvent, FormSubmitEvent } from '@nuxt/ui'
import { FetchError } from 'ofetch'
import { createProjectSchema, type CreateProjectInput } from '~~/shared/schemas/project'

const props = defineProps<{
  /**
   * The organization to create under. Undefined on an empty project list, where
   * the dashboard has nothing to name one with — the server then resolves the
   * single seeded organization (spec §5) and reports which one it used.
   */
  org?: string
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [] }>()

type CreatedProject = { id: string; org: string; slug: string }

const state = reactive<Partial<CreateProjectInput>>({ project: undefined })
const pending = ref(false)
const formError = ref<string | null>(null)
const created = ref<CreatedProject | null>(null)

const origin = useRequestURL().origin
const snippet = computed(() =>
  created.value
    ? backendSnippet({ origin, org: created.value.org, project: created.value.slug })
    : ''
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

async function onSubmit(event: FormSubmitEvent<CreateProjectInput>) {
  pending.value = true
  formError.value = null
  try {
    created.value = await $fetch<CreatedProject>('/api/ui/projects', {
      method: 'POST',
      body: { org: props.org, project: event.data.project }
    })
    emit('created')
  } catch (error) {
    // The server's own statusMessage names the actual problem — a duplicate
    // slug, an unknown organization, none seeded yet. Discarding it for
    // "check that you are still signed in" sent people to fix the one thing
    // that was not wrong.
    const detail = error instanceof FetchError ? error.statusMessage : undefined
    formError.value =
      detail ?? 'Could not create the project. Check that you are still signed in, then try again.'
  } finally {
    pending.value = false
  }
}

function onError(event: FormErrorEvent) {
  const id = event.errors[0]?.id
  if (id) document.getElementById(id)?.focus()
}

// A fresh dialog every time, so reopening after a success shows the form rather
// than the previous project's configuration.
watch(open, (isOpen) => {
  if (isOpen) return
  created.value = null
  formError.value = null
  copied.value = false
  copyError.value = null
  state.project = undefined
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="created ? 'Project Created' : 'New Project'"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
  >
    <template #body>
      <UForm
        v-if="!created"
        :schema="createProjectSchema"
        :state="state"
        class="space-y-6"
        @submit="onSubmit"
        @error="onError"
      >
        <UFormField
          label="Project Name"
          name="project"
          description="Lowercase letters, digits and dashes. This becomes the last segment of the backend address, so it cannot be renamed later without repointing every workspace that uses it."
          required
        >
          <UInput
            v-model="state.project"
            name="project-slug"
            autocomplete="off"
            autocapitalize="none"
            :spellcheck="false"
            placeholder="myapp-prod…"
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
          :label="pending ? 'Creating Project…' : 'Create Project'"
          icon="i-lucide-plus"
        />
      </UForm>

      <div v-else class="space-y-4">
        <UAlert
          color="success"
          variant="subtle"
          icon="i-lucide-check"
          :description="`${created.org}/${created.slug} is ready. Point a backend block at it and run terraform init.`"
        />

        <div>
          <div class="mb-2 flex items-center justify-between gap-2">
            <h3 class="text-sm font-medium">Backend Configuration</h3>
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
            class="overflow-x-auto rounded-lg bg-muted p-3 text-xs [overscroll-behavior-x:contain]"
            translate="no"
          ><code>{{ snippet }}</code></pre>
        </div>

        <div aria-live="polite">
          <p v-if="copyError" class="text-sm text-error text-pretty">{{ copyError }}</p>
        </div>

        <p class="text-sm text-muted text-pretty">
          Authenticate with a token rather than putting one in the file:
          <code class="text-xs" translate="no">export TF_HTTP_PASSWORD='sm_…'</code>. Create one on
          the
          <NuxtLink to="/tokens" class="text-primary underline underline-offset-2">
            Tokens
          </NuxtLink>
          page and scope it to
          <code class="text-xs" translate="no">{{ created.org }}/{{ created.slug }}</code
          >.
        </p>
      </div>
    </template>

    <template v-if="created" #footer>
      <UButton label="Done" block @click="open = false" />
    </template>
  </UModal>
</template>
