export default defineNuxtRouteMiddleware(async (to) => {
  const session = await loadSession()

  if (to.path === '/login') {
    return session ? navigateTo('/') : undefined
  }

  if (!session) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
