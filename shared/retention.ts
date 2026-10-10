export type RetentionValues = { keepVersions: number; keepDays: number }
export type RetentionOverride = { keepVersions: number | null; keepDays: number | null }
export type RetentionSource = 'default' | 'project'
export type EffectiveRetention = RetentionValues & {
  source: { versions: RetentionSource; days: RetentionSource }
}

/**
 * A project's retention, each field falling back to the deployment's on its
 * own (project-settings spec §6). Shared so the Settings tab can say where a
 * value came from without restating the rule.
 */
export function effectiveRetention(
  override: RetentionOverride,
  defaults: RetentionValues
): EffectiveRetention {
  return {
    keepVersions: override.keepVersions ?? defaults.keepVersions,
    keepDays: override.keepDays ?? defaults.keepDays,
    source: {
      versions: override.keepVersions === null ? 'default' : 'project',
      days: override.keepDays === null ? 'default' : 'project'
    }
  }
}
