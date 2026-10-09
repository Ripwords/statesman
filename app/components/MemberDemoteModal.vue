<script setup lang="ts">
import type { ProjectRole } from '~~/shared/schemas/project-role'

type Target = { userId: string; email: string }

defineProps<{ open: boolean; member: Target | null; next: ProjectRole | null; self: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; confirm: [] }>()
</script>

<template>
  <UModal
    :open="open"
    title="Demote the Last Owner?"
    :ui="{ content: 'overscroll-contain', body: 'overscroll-contain' }"
    @update:open="(value) => emit('update:open', value)"
  >
    <template #body>
      <div class="space-y-3">
        <p class="text-sm text-muted text-pretty">
          <template v-if="self">You will become</template>
          <template v-else>
            <span class="break-all font-medium" translate="no">{{ member?.email }}</span> will
            become
          </template>
          {{ next === 'editor' ? 'an' : 'a' }} {{ next }} on this project<template v-if="self"
            >, and lose the controls for managing it</template
          >.
        </p>
        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          description="This project will have no owners. Only an admin can manage its members after this."
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          label="Cancel"
          @click="emit('update:open', false)"
        />
        <UButton color="warning" label="Change Role" @click="emit('confirm')" />
      </div>
    </template>
  </UModal>
</template>
