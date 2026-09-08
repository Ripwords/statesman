<script setup lang="ts">
/**
 * Renders its slot for an admin, and an explanation for everyone else.
 *
 * This is not the enforcement. Every route behind it refuses a member
 * server-side, and this component only decides what the page says while that is
 * true — a member who types the URL should read a sentence, not watch a table
 * fail to load. Saying why, and who can help, beats a bare "denied".
 */
defineProps<{ what: string }>()

const { isAdmin } = useAuth()
</script>

<template>
  <slot v-if="isAdmin" />
  <EmptyState
    v-else
    icon="i-lucide-lock"
    title="Admins Only"
    :description="`${what} is limited to admin accounts. Your account is a member, which can read every project, version and diff. Ask an admin to make the change, or to change your role.`"
  />
</template>
