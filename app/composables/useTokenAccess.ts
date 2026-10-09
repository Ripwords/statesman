/**
 * Whether the Tokens page is worth offering: admins, owners of any project,
 * and anyone who already holds a token (they can list and revoke it). Reuses
 * the fetches the pages make, so it adds no request of its own.
 */
export function useTokenAccess() {
  const { isAdmin } = useAuth()
  const { data: projects } = useFetch('/api/ui/projects')
  const { data: tokens } = useFetch('/api/ui/tokens')

  const ownsAnyProject = computed(() => projects.value?.some((p) => p.myRole === 'owner') ?? false)
  const canCreate = computed(() => isAdmin.value || ownsAnyProject.value)
  const showTokens = computed(() => canCreate.value || (tokens.value?.length ?? 0) > 0)

  return { canCreate, showTokens }
}
