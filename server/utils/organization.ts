export type OrganizationRow = { id: string; slug: string }

/**
 * Picks the organization a create request means, or explains why it cannot.
 *
 * Split out from the handler and given the rows rather than the database so
 * every branch is testable without arranging a particular set of organizations
 * in a database several suites share.
 *
 * `createError` is Nitro's auto-import; `h3` is not directly resolvable from
 * this package, so a test importing this module has to load
 * tests/ui/nitro-globals first.
 */
export function chooseOrganization(
  requested: string | undefined,
  organizations: readonly OrganizationRow[]
): OrganizationRow {
  if (requested !== undefined) {
    const match = organizations.find((o) => o.slug === requested)
    // Spec §11: an org that does not exist is a 404, the same answer the
    // Terraform router gives for the same slug.
    if (!match)
      throw createError({ statusCode: 404, statusMessage: `Unknown organization: ${requested}` })
    return match
  }

  const [only, ...rest] = organizations
  if (!only) {
    throw createError({
      statusCode: 404,
      statusMessage: 'No organization exists yet. Run `pnpm db:seed` to create one.'
    })
  }
  // v1 is single-organization, so this is unreachable in a supported
  // deployment. Guessing would be worse than asking: the choice decides which
  // `:org` segment every future backend address carries.
  if (rest.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Several organizations exist; name one in the request body.'
    })
  }
  return only
}
