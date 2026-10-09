<script setup lang="ts">
/**
 * Renders its slot when the caller's project role allows `permission`, and
 * nothing otherwise — the project-level twin of AdminOnly's `quiet` mode.
 * Not the enforcement: every route behind it checks server-side.
 */
import {
  roleAllows,
  type EffectiveRole,
  type ProjectPermission
} from '~~/shared/project-permissions'

const props = defineProps<{
  role: EffectiveRole | null | undefined
  permission: ProjectPermission
}>()
const allowed = computed(() => roleAllows(props.role, props.permission))
</script>

<template>
  <slot v-if="allowed" />
</template>
