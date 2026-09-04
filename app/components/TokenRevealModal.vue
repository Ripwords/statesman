<script setup lang="ts">
const props = defineProps<{ token: { key: string; name: string } | null }>()
const emit = defineEmits<{ close: [] }>()

const open = computed({
  get: () => props.token !== null,
  set: (value: boolean) => {
    if (!value) emit('close')
  }
})

const copied = ref(false)
const copyError = ref<string | null>(null)
let resetTimer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  if (!props.token) return
  try {
    await navigator.clipboard.writeText(props.token.key)
    copyError.value = null
    copied.value = true
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    copied.value = false
    copyError.value =
      'The clipboard is not available here. Select the token above and copy it manually.'
  }
}

function selectAll(event: FocusEvent) {
  const field = event.target
  if (field instanceof HTMLInputElement) field.select()
}

// The raw key exists nowhere else — a reload while this dialog is open loses it
// for good, so the browser asks first.
function warnBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault()
}

watch(
  () => props.token,
  (token) => {
    if (import.meta.server) return
    if (token) window.addEventListener('beforeunload', warnBeforeUnload)
    else window.removeEventListener('beforeunload', warnBeforeUnload)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (resetTimer) clearTimeout(resetTimer)
  if (import.meta.client) window.removeEventListener('beforeunload', warnBeforeUnload)
})

const origin = useRequestURL().origin

// ORG/PROJECT stay placeholders here: a token can be scoped to several
// projects, so this modal cannot know which one the reader means. The project
// reveal fills them in for real. The block itself comes from the one builder
// both share, so the verbs cannot drift apart.
const snippet = computed(() =>
  backendSnippet({
    origin,
    org: 'ORG',
    project: 'PROJECT',
    password: props.token?.key ?? ''
  })
)
</script>

<template>
  <!--
    :dismissible stops Escape and outside-click; :close removes the header X.
    Both are needed: the key is unrecoverable, so every exit from this dialog
    should be the deliberate button at the bottom.
  -->
  <UModal
    v-model:open="open"
    title="Copy Your Token Now"
    :dismissible="false"
    :close="false"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
  >
    <template #body>
      <div class="space-y-4">
        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          description="This is the only time the token is shown. Copy it before closing this dialog — it cannot be retrieved later."
        />

        <div class="flex gap-2">
          <UInput
            :model-value="token?.key"
            readonly
            name="token-value"
            autocomplete="off"
            :spellcheck="false"
            aria-label="Your new token"
            class="w-full font-mono"
            @focus="selectAll"
          />
          <UButton
            :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            :color="copied ? 'success' : 'neutral'"
            variant="outline"
            :aria-label="copied ? 'Token copied to clipboard' : 'Copy token to clipboard'"
            @click="copy"
          />
        </div>

        <div aria-live="polite">
          <p v-if="copied" class="text-sm text-success">Copied to your clipboard.</p>
          <p v-else-if="copyError" class="text-sm text-error text-pretty">{{ copyError }}</p>
        </div>

        <div>
          <h3 class="mb-2 text-sm font-medium">Backend Configuration</h3>
          <pre
            class="overflow-x-auto rounded-lg bg-muted p-3 text-xs [overscroll-behavior-x:contain]"
            translate="no"
          ><code>{{ snippet }}</code></pre>
        </div>
      </div>
    </template>
    <template #footer>
      <UButton label="I Have Copied It" block @click="emit('close')" />
    </template>
  </UModal>
</template>
