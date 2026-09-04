<script setup lang="ts">
defineProps<{ icon: string; title: string; description: string }>()
</script>

<template>
  <div class="rounded-lg border border-dashed border-default px-6 py-16 text-center">
    <UIcon :name="icon" class="mx-auto size-8 text-muted" aria-hidden="true" />
    <h2 class="mt-4 font-medium text-balance">{{ title }}</h2>
    <p class="mx-auto mt-1 max-w-sm text-sm text-muted text-pretty">{{ description }}</p>
    <div v-if="$slots.default" class="mt-6">
      <slot />
    </div>
  </div>
</template>
