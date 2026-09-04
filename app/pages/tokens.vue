<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: 'Tokens · statesman' })

const { data: tokens, refresh } = await useFetch('/api/ui/tokens')
type TokenRow = NonNullable<typeof tokens.value>[number]

const revealed = ref<{ id: string, key: string, name: string } | null>(null)
const creating = ref(false)

const pendingRevoke = ref<TokenRow | null>(null)
const revoking = ref(false)
const revokeError = ref<string | null>(null)
const notice = ref<string | null>(null)

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

function scopeLabel(token: TokenRow): string {
  if (!token.scope) return 'Unknown scope'
  return token.scope.kind === 'all'
    ? 'All projects'
    : `${token.scope.projects.length} project${token.scope.projects.length === 1 ? '' : 's'}`
}

async function revoke() {
  const token = pendingRevoke.value
  if (!token) return
  revoking.value = true
  revokeError.value = null
  try {
    await $fetch(`/api/ui/tokens/${token.id}`, { method: 'DELETE' })
    pendingRevoke.value = null
    notice.value = `Revoked ${token.name ?? 'the token'}. Any Terraform run using it will now fail to authenticate.`
    await refresh()
  } catch {
    revokeError.value = 'Could not revoke the token. Check that you are still signed in, then try again.'
  } finally {
    revoking.value = false
  }
}

function onCreated(token: { id: string, key: string, name: string }) {
  revealed.value = token
  creating.value = false
  notice.value = null
  void refresh()
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between gap-4">
      <h1 class="scroll-mt-24 text-xl font-semibold tracking-tight text-balance">Tokens</h1>
      <UButton icon="i-lucide-plus" label="New Token" @click="creating = true" />
    </div>

    <div aria-live="polite">
      <UAlert
        v-if="notice"
        color="success"
        variant="subtle"
        icon="i-lucide-check"
        :description="notice"
        :close="true"
        @update:open="notice = null"
      />
    </div>

    <EmptyState
      v-if="!tokens?.length"
      icon="i-lucide-key-round"
      title="No Tokens Yet"
      description="Terraform authenticates with a token. Create one, then paste it into the password field of your backend block."
    >
      <UButton icon="i-lucide-plus" label="Create Your First Token" @click="creating = true" />
    </EmptyState>

    <ul v-else class="grid gap-2">
      <li
        v-for="t in tokens"
        :key="t.id"
        class="[contain-intrinsic-size:auto_3.5rem] flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-default px-4 py-3 [content-visibility:auto]"
      >
        <span class="min-w-0 truncate font-medium">{{ t.name ?? 'Unnamed' }}</span>
        <code class="text-xs text-muted" translate="no">{{ t.start }}…</code>
        <UBadge
          :color="t.enabled ? 'success' : 'neutral'"
          variant="subtle"
          :label="t.enabled ? 'Active' : 'Disabled'"
        />
        <span class="text-sm text-muted">{{ scopeLabel(t) }}</span>
        <span class="text-sm text-muted tabular">
          {{ t.rateLimitMax ?? 120 }}/{{ Math.round((t.rateLimitTimeWindow ?? 60_000) / 1000) }}s
        </span>
        <span v-if="t.expiresAt" class="text-sm text-muted tabular">
          <ClientOnly fallback="—">Expires {{ when.format(new Date(t.expiresAt)) }}</ClientOnly>
        </span>
        <UButton
          class="ms-auto"
          color="error"
          variant="ghost"
          icon="i-lucide-trash-2"
          :aria-label="`Revoke token ${t.name ?? 'Unnamed'}`"
          @click="pendingRevoke = t"
        />
      </li>
    </ul>

    <USlideover v-model:open="creating" title="New Token">
      <template #body>
        <TokenConfigurator @created="onCreated" />
      </template>
    </USlideover>

    <UModal
      :open="pendingRevoke !== null"
      title="Revoke This Token?"
      @update:open="(value) => { if (!value) pendingRevoke = null }"
    >
      <template #body>
        <div class="space-y-3 overscroll-contain">
          <p class="text-sm text-muted text-pretty">
            Revoking {{ pendingRevoke?.name ?? 'this token' }} takes effect immediately and
            cannot be undone. Any Terraform run still configured with it will fail to
            authenticate on its next plan or apply.
          </p>
          <div aria-live="polite">
            <UAlert
              v-if="revokeError"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :description="revokeError"
            />
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="pendingRevoke = null" />
          <UButton
            color="error"
            :loading="revoking"
            :label="revoking ? 'Revoking…' : 'Revoke Token'"
            @click="revoke"
          />
        </div>
      </template>
    </UModal>

    <TokenRevealModal :token="revealed" @close="revealed = null" />
  </div>
</template>
