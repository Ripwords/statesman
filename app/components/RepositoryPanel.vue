<script setup lang="ts">
import type { LinkSummary } from '~~/server/utils/variable-status'
import { linkDescription } from '~/utils/repository-link'
import { relativeTime } from '~/utils/relative-time'
import { statusMessageOf } from '~/utils/status-message'

import type { EffectiveRole } from '~~/shared/project-permissions'

const props = defineProps<{
  environmentId: string
  link: LinkSummary | null
  role: EffectiveRole | null | undefined
}>()
const emit = defineEmits<{ changed: [] }>()

const { isAdmin } = useAuth()
const { can } = useProjectRole(toRef(props, 'role'))
const { data: github } = await useFetch('/api/ui/github')

const linkOpen = ref(false)
const unlinkOpen = ref(false)
const syncing = ref(false)
const unlinking = ref(false)
const actionError = ref<string | null>(null)
const unlinkError = ref<string | null>(null)

async function syncNow() {
  syncing.value = true
  actionError.value = null
  try {
    // A failed sync is a 200 with `ok: false`, and the route records the error on
    // the link, so a refresh is what shows it.
    await $fetch(`/api/ui/environments/${props.environmentId}/sync`, { method: 'POST' })
    emit('changed')
  } catch (error) {
    actionError.value = statusMessageOf(
      error,
      'Could not sync. Check your connection, then try again.'
    )
  } finally {
    syncing.value = false
  }
}

function openUnlink() {
  unlinkError.value = null
  unlinkOpen.value = true
}

async function unlink() {
  unlinking.value = true
  unlinkError.value = null
  try {
    await $fetch(`/api/ui/environments/${props.environmentId}/link`, { method: 'DELETE' })
    unlinkOpen.value = false
    emit('changed')
  } catch (error) {
    unlinkError.value = statusMessageOf(
      error,
      'Could not unlink. Check your connection, then try again.'
    )
  } finally {
    unlinking.value = false
  }
}

const copied = ref(false)
const copyError = ref<string | null>(null)
let resetTimer: ReturnType<typeof setTimeout> | undefined

async function copySha() {
  if (!props.link?.lastSyncedSha) return
  try {
    await navigator.clipboard.writeText(props.link.lastSyncedSha)
    copyError.value = null
    copied.value = true
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    copied.value = false
    copyError.value = 'The clipboard is not available here. Select the hash and copy it manually.'
  }
}

onBeforeUnmount(() => {
  if (resetTimer) clearTimeout(resetTimer)
})
</script>

<template>
  <section
    v-if="github?.configured && (link || can('environment:link'))"
    aria-label="GitHub repository"
    class="rounded-lg border border-default px-4 py-3 text-sm"
  >
    <template v-if="link">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <UIcon name="i-lucide-github" class="size-4 shrink-0" />
        <div class="min-w-0 flex-1 basis-60">
          <p class="break-words font-mono" translate="no">{{ linkDescription(link) }}</p>
          <p class="text-muted">
            <template v-if="link.lastSyncedAt">
              <ClientOnly fallback="Synced"
                >Synced {{ relativeTime(link.lastSyncedAt) }}</ClientOnly
              >
            </template>
            <template v-else>Not synced yet</template>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <ProjectOnly :role="role" permission="environment:sync">
            <UButton
              label="Sync now"
              icon="i-lucide-refresh-cw"
              size="sm"
              color="neutral"
              variant="outline"
              :loading="syncing"
              @click="syncNow"
            />
          </ProjectOnly>
          <ProjectOnly :role="role" permission="environment:link">
            <UButton
              label="Unlink"
              icon="i-lucide-unlink"
              size="sm"
              color="error"
              variant="ghost"
              @click="openUnlink"
            />
          </ProjectOnly>
        </div>
      </div>

      <UAlert
        v-if="link.lastSyncError"
        class="mt-3"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="The last sync failed"
        :description="link.lastSyncError"
      />

      <div aria-live="polite">
        <UAlert
          v-if="actionError"
          class="mt-3"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="actionError"
        />
      </div>

      <details v-if="link.lastSyncedSha" class="mt-3">
        <summary class="cursor-pointer text-muted">Technical details</summary>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <span class="text-muted">Last synced commit</span>
          <code class="break-all text-xs" translate="no">{{ link.lastSyncedSha }}</code>
          <UButton
            size="xs"
            :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            :color="copied ? 'success' : 'neutral'"
            variant="outline"
            :label="copied ? 'Copied' : 'Copy'"
            @click="copySha"
          />
        </div>
        <p v-if="copyError" class="mt-2 text-error text-pretty">{{ copyError }}</p>
      </details>

      <UModal
        v-model:open="unlinkOpen"
        title="Unlink Repository?"
        :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
      >
        <template #body>
          <div class="space-y-3">
            <p class="text-sm text-muted text-pretty">
              <span class="font-mono break-all" translate="no">{{ link.repoFullName }}</span>
              will stop syncing into this environment. Stored values stay; declared variables are
              removed until you link again.
            </p>
            <div aria-live="polite">
              <UAlert
                v-if="unlinkError"
                color="error"
                variant="subtle"
                icon="i-lucide-triangle-alert"
                :description="unlinkError"
              />
            </div>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" label="Cancel" @click="unlinkOpen = false" />
            <UButton
              color="error"
              :loading="unlinking"
              :label="unlinking ? 'Unlinking…' : 'Unlink'"
              @click="unlink"
            />
          </div>
        </template>
      </UModal>
    </template>

    <ProjectOnly v-else :role="role" permission="environment:link">
      <div class="flex flex-wrap items-center gap-3">
        <UIcon name="i-lucide-github" class="size-4 shrink-0" />
        <p class="min-w-0 flex-1 text-muted text-pretty">
          Declare this environment's variables in a repository.
        </p>
        <!-- Connecting the App is deployment-wide, so only an admin is offered it. -->
        <UButton
          v-if="github.installations.length > 0"
          label="Link repository"
          icon="i-lucide-link"
          size="sm"
          @click="linkOpen = true"
        />
        <UButton
          v-else-if="isAdmin"
          label="Connect GitHub"
          icon="i-lucide-github"
          size="sm"
          :href="github.installUrl ?? undefined"
          external
        />
        <p v-else class="text-muted text-pretty">An admin must connect GitHub first.</p>
      </div>
    </ProjectOnly>

    <RepositoryLinkModal
      v-if="can('environment:link')"
      v-model:open="linkOpen"
      :environment-id="environmentId"
      :installations="github.installations"
      @linked="emit('changed')"
    />
  </section>
</template>
