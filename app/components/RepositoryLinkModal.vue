<script setup lang="ts">
import type { InstallationSummary } from '~~/server/services/sync'
import { firstSyncFailure } from '~/utils/repository-link'
import { statusMessageOf } from '~/utils/status-message'

const props = defineProps<{
  environmentId: string
  installations: InstallationSummary[]
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ linked: [] }>()

const requestFetch = useRequestFetch()

const chosenInstallation = ref<number | undefined>(props.installations[0]?.installationId)
const installationId = computed(
  () => chosenInstallation.value ?? props.installations[0]?.installationId ?? null
)
const installationOptions = computed(() =>
  props.installations.map((i) => ({ label: i.accountLogin, value: i.installationId }))
)

const {
  data: repositories,
  error: repositoriesError,
  status: repositoriesStatus
} = await useAsyncData(
  () => `github-repositories:${installationId.value}`,
  // Listing repositories calls GitHub, so only ask while the modal is showing.
  async () =>
    open.value && installationId.value !== null
      ? await requestFetch(`/api/ui/github/installations/${installationId.value}/repositories`)
      : null,
  { watch: [open] }
)
const repositoryItems = computed(() =>
  (repositories.value ?? []).map((r) => ({ label: r.fullName, value: r.id }))
)

const repoId = ref<number | undefined>(undefined)
const branch = ref('')
const directory = ref('')
const defaultBranch = computed(
  () => repositories.value?.find((r) => r.id === repoId.value)?.defaultBranch ?? 'main'
)

const pending = ref(false)
const formError = ref<string | null>(null)
// The link row exists once the PUT answers, even when the first sync failed, so a
// second submit would only repeat it. This state ends the form instead.
const linkedWithError = ref(false)

watch(installationId, () => {
  repoId.value = undefined
})

async function submit() {
  if (repoId.value === undefined || installationId.value === null) {
    formError.value = 'Choose a repository.'
    return
  }
  pending.value = true
  formError.value = null
  try {
    const result = await $fetch(`/api/ui/environments/${props.environmentId}/link`, {
      method: 'PUT',
      body: {
        installationId: installationId.value,
        repoId: repoId.value,
        ref: branch.value.trim() === '' ? undefined : branch.value.trim(),
        directory: directory.value.trim()
      }
    })
    emit('linked')
    if (result.ok) open.value = false
    else {
      linkedWithError.value = true
      formError.value = firstSyncFailure(result.error)
    }
  } catch (error) {
    formError.value = statusMessageOf(
      error,
      'Could not link the repository. Check that you are still signed in, then try again.'
    )
  } finally {
    pending.value = false
  }
}

watch(open, (isOpen) => {
  if (isOpen) return
  formError.value = null
  linkedWithError.value = false
  repoId.value = undefined
  branch.value = ''
  directory.value = ''
})
</script>

<template>
  <UModal
    v-model:open="open"
    title="Link Repository"
    description="Variable declarations are read from the .tf files in one directory."
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
  >
    <template #body>
      <form class="space-y-5" @submit.prevent="submit">
        <UFormField v-if="installations.length > 1" label="GitHub Account">
          <USelect
            v-model="chosenInstallation"
            :disabled="linkedWithError"
            :items="installationOptions"
            :placeholder="installationOptions[0]?.label"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Repository" required>
          <USelectMenu
            v-model="repoId"
            :disabled="linkedWithError"
            :items="repositoryItems"
            value-key="value"
            :loading="repositoriesStatus === 'pending'"
            placeholder="Choose a repository"
            class="w-full"
          />
        </UFormField>
        <UAlert
          v-if="repositoriesError"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="statusMessageOf(repositoriesError, 'Could not list repositories.')"
        />

        <UFormField label="Branch" description="Leave empty to follow the default branch.">
          <UInput
            v-model="branch"
            :disabled="linkedWithError"
            :placeholder="defaultBranch"
            autocomplete="off"
            autocapitalize="none"
            :spellcheck="false"
            class="w-full font-mono"
          />
        </UFormField>

        <UFormField label="Directory">
          <UInput
            v-model="directory"
            :disabled="linkedWithError"
            placeholder="envs/prod (empty for the repository root)"
            autocomplete="off"
            autocapitalize="none"
            :spellcheck="false"
            class="w-full font-mono"
          />
        </UFormField>

        <div aria-live="polite">
          <UAlert
            v-if="formError"
            :color="linkedWithError ? 'warning' : 'error'"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="formError"
          />
        </div>

        <UButton v-if="linkedWithError" label="Done" icon="i-lucide-check" @click="open = false" />
        <UButton
          v-else
          type="submit"
          :loading="pending"
          :label="pending ? 'Linking…' : 'Link Repository'"
          icon="i-lucide-link"
        />
      </form>
    </template>
  </UModal>
</template>
