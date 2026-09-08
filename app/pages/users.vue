<script setup lang="ts">
import { roleOf, type UserRole } from '~~/shared/schemas/user'

definePageMeta({ layout: 'dashboard' })
useHead({ title: 'Users · statesman' })

const { user: me, isAdmin } = useAuth()

// Only an admin can read this, and asking as a member would answer 403 and
// paint an error over the explanation AdminOnly is already showing.
const {
  data: users,
  error,
  refresh
} = await useFetch('/api/ui/users', { immediate: isAdmin.value })
type UserRow = NonNullable<typeof users.value>[number]

const revealed = ref<{ email: string; password: string } | null>(null)
const notice = ref<string | null>(null)
const actionError = ref<string | null>(null)

/** The id currently being changed, so only that row's control shows a spinner. */
const busyId = ref<string | null>(null)
const pendingReset = ref<UserRow | null>(null)

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

const roleOptions: Array<{ label: string; value: UserRole }> = [
  { label: 'Admin', value: 'admin' },
  { label: 'Member', value: 'member' }
]

const adminCount = computed(
  () => users.value?.filter((u) => roleOf(u.role) === 'admin').length ?? 0
)

/**
 * The server refuses this too — it is the authority, and it counts in the same
 * transaction rather than from a list that may be seconds stale. Disabling the
 * control is only so the last admin is not invited to try.
 */
function isLastAdmin(row: UserRow): boolean {
  return roleOf(row.role) === 'admin' && adminCount.value <= 1
}

async function changeRole(row: UserRow, role: UserRole) {
  if (roleOf(row.role) === role) return
  busyId.value = row.id
  actionError.value = null
  notice.value = null
  try {
    await $fetch(`/api/ui/users/${row.id}/role`, { method: 'PATCH', body: { role } })
    notice.value = `${row.email} is now ${role === 'admin' ? 'an admin' : 'a member'}.`
    await refresh()
  } catch (caught: unknown) {
    actionError.value = messageOf(
      caught,
      `Could not change the role for ${row.email}. Check that you are still signed in, then try again.`
    )
    // The select shows the value the user picked until this reload puts the
    // real one back; leaving it optimistic would be a lie about the server.
    await refresh()
  } finally {
    busyId.value = null
  }
}

async function resetPassword() {
  const row = pendingReset.value
  if (!row) return
  busyId.value = row.id
  actionError.value = null
  notice.value = null
  try {
    const result = await $fetch(`/api/ui/users/${row.id}/password`, { method: 'POST' })
    pendingReset.value = null
    revealed.value = { email: row.email, password: result.password }
  } catch (caught: unknown) {
    actionError.value = messageOf(
      caught,
      `Could not reset the password for ${row.email}. Check that you are still signed in, then try again.`
    )
  } finally {
    busyId.value = null
  }
}

/**
 * The server's own sentence when it sent one — it knows why it refused, and
 * "this is the only admin" is far more use than a generic failure.
 */
function messageOf(caught: unknown, fallback: string): string {
  if (typeof caught === 'object' && caught !== null && 'statusMessage' in caught) {
    const message = (caught as { statusMessage?: unknown }).statusMessage
    if (typeof message === 'string' && message !== '') return message
  }
  return fallback
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="scroll-mt-24 text-xl font-semibold tracking-tight text-balance">Users</h1>

    <AdminOnly what="Managing accounts">
      <div class="space-y-6">
        <p class="max-w-prose text-sm text-muted text-pretty">
          Admins manage accounts, roles, tokens, locks and history. Members read projects, versions
          and diffs. Both read every project’s decrypted state, so a member is not a reduced-trust
          account — add people here only if they may see every secret in every state file. New
          accounts are made from the command line with
          <code class="text-xs" translate="no">pnpm user:create</code>.
        </p>

        <div aria-live="polite" class="space-y-3">
          <UAlert
            v-if="notice"
            color="success"
            variant="subtle"
            icon="i-lucide-check"
            :description="notice"
            :close="true"
            @update:open="notice = null"
          />
          <UAlert
            v-if="actionError"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="actionError"
            :close="true"
            @update:open="actionError = null"
          />
        </div>

        <div v-if="error" aria-live="polite">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Could Not Load Users"
            description="The server did not answer. This is a problem reaching statesman, not a sign that there are no accounts."
          >
            <template #actions>
              <UButton color="error" variant="outline" label="Retry" @click="refresh()" />
            </template>
          </UAlert>
        </div>

        <ul v-else class="grid gap-2">
          <li
            v-for="u in users"
            :key="u.id"
            class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-default px-4 py-3"
          >
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="min-w-0 truncate font-medium">{{ u.email }}</span>
              <span class="min-w-0 truncate text-sm text-muted">
                {{ u.name }}
                <template v-if="u.id === me?.id"> · you</template>
              </span>
            </div>

            <span class="text-sm text-muted tabular">
              <ClientOnly fallback="—">Added {{ when.format(new Date(u.createdAt)) }}</ClientOnly>
            </span>

            <USelect
              :model-value="roleOf(u.role)"
              :items="roleOptions"
              value-key="value"
              :disabled="busyId === u.id || isLastAdmin(u)"
              class="w-32"
              :aria-label="`Role for ${u.email}`"
              @update:model-value="(role: UserRole) => changeRole(u, role)"
            />

            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-key-round"
              :disabled="u.id === me?.id || busyId === u.id"
              :aria-label="`Reset password for ${u.email}`"
              @click="pendingReset = u"
            />
          </li>
        </ul>

        <p v-if="adminCount <= 1" class="text-sm text-muted text-pretty">
          There is one admin. Its role cannot be changed until another account is promoted —
          otherwise nobody would be left able to manage accounts, tokens or locks.
        </p>
      </div>
    </AdminOnly>

    <UModal
      :open="pendingReset !== null"
      title="Reset This Password?"
      :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
      @update:open="
        (value) => {
          if (!value) pendingReset = null
        }
      "
    >
      <template #body>
        <p class="text-sm text-muted text-pretty">
          A new password is generated for {{ pendingReset?.email }} and shown once. Their current
          password stops working and every session they have is ended, so they are signed out
          everywhere until you give them the new one.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="pendingReset = null" />
          <UButton
            :loading="busyId !== null"
            :label="busyId !== null ? 'Resetting…' : 'Reset Password'"
            @click="resetPassword"
          />
        </div>
      </template>
    </UModal>

    <PasswordRevealModal :reveal="revealed" @close="revealed = null" />
  </div>
</template>
