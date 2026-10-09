import { db } from '../db/client'
import { organization } from '../db/schema'
import { chooseOrganization } from './organization'

/** GitHub installations belong to the deployment, which has one organization (base §5). */
export async function deploymentOrgId(): Promise<string> {
  const rows = await db()
    .select({ id: organization.id, slug: organization.slug })
    .from(organization)
  return chooseOrganization(undefined, rows).id
}
