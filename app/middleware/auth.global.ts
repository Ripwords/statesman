export default defineNuxtRouteMiddleware(async (to) => {
  const session = await loadSession()

  if (to.path === '/login') {
    // Already signed in: honour the destination the guard recorded rather than
    // dropping the user on the dashboard and losing where they were going.
    if (session.status !== 'authenticated') return
    return navigateTo(safeInternalPath(to.query.redirect))
  }

  if (session.status === 'authenticated') return

  return navigateTo({
    path: '/login',
    query: {
      redirect: to.fullPath,
      // Tells the sign-in page to say the service was unreachable rather than
      // implying the visitor was signed out.
      ...(session.status === 'unavailable' ? { reason: 'unavailable' } : {})
    }
  })
})
