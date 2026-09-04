import { runRetentionForAllProjects } from '../services/retention'
import { env } from '../utils/env'

/**
 * The scheduled retention pass.
 *
 * RETENTION_KEEP_VERSIONS and RETENTION_KEEP_DAYS were documented settings that
 * nothing ever acted on: the only trigger was a session-guarded admin route
 * with no button behind it, so no deployment pruned anything while two UI
 * strings told users versions had been "removed by retention".
 *
 * Nitro's scheduler runs on a long-lived server and not on serverless presets,
 * which is the honest split — there is no process on Vercel to hold a timer.
 * That deployment needs an external trigger against POST /api/admin/retention,
 * and docs/deploy-vercel.md says so rather than implying this covers it.
 */
export default defineTask({
  meta: {
    name: 'retention',
    description: 'Prune state versions past both retention thresholds, and sweep orphaned blobs'
  },
  // One shape for both branches: defineTask infers the result type from the
  // return, and two shapes make it a union nothing can satisfy.
  async run() {
    if (env().IS_SERVERLESS) {
      return { result: { skipped: true, prunedVersions: 0, sweptBlobs: 0 } }
    }
    const summary = await runRetentionForAllProjects()
    console.log(
      `[statesman] retention: pruned ${summary.prunedVersions} versions, swept ${summary.sweptBlobs} blobs`
    )
    return { result: { skipped: false, ...summary } }
  }
})
