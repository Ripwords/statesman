<script setup lang="ts">
// Set here rather than per-page so Nuxt's built-in error page inherits it too;
// a page-level useHead never runs when the error page renders.
useHead({ htmlAttrs: { lang: 'en' } })
</script>

<template>
  <UApp>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
