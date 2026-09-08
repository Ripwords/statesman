<script setup lang="ts">
const props = defineProps<{ reveal: { email: string; password: string } | null }>()
const emit = defineEmits<{ close: [] }>()

const open = computed({
  get: () => props.reveal !== null,
  set: (value: boolean) => {
    if (!value) emit('close')
  }
})

const copied = ref(false)
const copyError = ref<string | null>(null)
let resetTimer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  if (!props.reveal) return
  try {
    await navigator.clipboard.writeText(props.reveal.password)
    copyError.value = null
    copied.value = true
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    copied.value = false
    copyError.value =
      'The clipboard is not available here. Select the password above and copy it manually.'
  }
}

function selectAll(event: FocusEvent) {
  const field = event.target
  if (field instanceof HTMLInputElement) field.select()
}

// Stored hashed and nowhere else in readable form: a reload while this dialog
// is open loses it for good, and the only way back is another reset.
function warnBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault()
}

watch(
  () => props.reveal,
  (reveal) => {
    if (import.meta.server) return
    if (reveal) window.addEventListener('beforeunload', warnBeforeUnload)
    else window.removeEventListener('beforeunload', warnBeforeUnload)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (resetTimer) clearTimeout(resetTimer)
  if (import.meta.client) window.removeEventListener('beforeunload', warnBeforeUnload)
})
</script>

<template>
  <!--
    Neither Escape nor an outside click closes this: the password is
    unrecoverable, so every exit should be the deliberate button at the bottom.
  -->
  <UModal
    v-model:open="open"
    :dismissible="false"
    :close="false"
    title="New Password"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
  >
    <template #body>
      <div class="space-y-4">
        <p class="text-sm text-muted text-pretty">
          Give this to
          <span class="font-medium text-default">{{ reveal?.email }}</span>
          over something you trust. It is stored hashed, so this dialog is the only place it is ever
          readable — closing it without copying means running another reset.
        </p>

        <UFormField label="Password">
          <div class="flex min-w-0 gap-2">
            <UInput
              :model-value="reveal?.password"
              readonly
              class="min-w-0 flex-1 font-mono"
              spellcheck="false"
              autocomplete="off"
              translate="no"
              aria-label="Generated password"
              @focus="selectAll"
            />
            <UButton
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              color="neutral"
              variant="subtle"
              :aria-label="copied ? 'Password copied' : 'Copy password'"
              @click="copy"
            />
          </div>
        </UFormField>

        <div aria-live="polite">
          <p v-if="copied" class="text-sm text-success">Copied.</p>
          <UAlert
            v-else-if="copyError"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="copyError"
          />
        </div>

        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-info"
          description="Their existing sessions were ended, so they are signed out everywhere until they sign in with this."
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton label="I Have Copied It" @click="emit('close')" />
      </div>
    </template>
  </UModal>
</template>
