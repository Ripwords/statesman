import type { DeclaredVariable } from '../../shared/schemas/variable'
import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  uniqueIndex,
  index
} from 'drizzle-orm/pg-core'

// --- Better Auth owned tables ------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // --- Better Auth admin plugin ---------------------------------------------
  // `admin` or `member` (shared/schemas/user.ts). Nullable and untyped at the
  // database level because that is how the plugin declares it; roleOf() is what
  // turns the column back into one of the two roles, defaulting to the lesser.
  role: text('role'),
  // Ban and impersonation are not features here — nothing in the UI or the API
  // sets them. The columns exist because the plugin READS them on every
  // sign-in and session lookup, and a missing column is an error, not a null.
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  // Same story as the ban columns: impersonation is not offered, but the
  // plugin's session queries select this column.
  impersonatedBy: text('impersonated_by'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  // Required as of Better Auth 1.7 — account identity is scoped by issuer.
  issuer: text('issuer').notNull(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

// Mirrors the table declared by @better-auth/api-key 1.7.2. Two columns differ
// from what a reader might expect: the owner column is `referenceId`, not
// `userId` (the plugin can reference an organization instead of a user), and
// `configId` selects between multiple named plugin configurations.
//
// The FK on referenceId -> user.id is ours, not the plugin's: this deployment
// only ever issues user-owned keys, and the cascade stops a deleted user from
// leaving live credentials behind.
export const apikey = pgTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    prefix: text('prefix'),
    key: text('key').notNull(),
    referenceId: text('reference_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at'),
    enabled: boolean('enabled').notNull().default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').notNull().default(true),
    rateLimitTimeWindow: bigint('rate_limit_time_window', { mode: 'number' }),
    rateLimitMax: integer('rate_limit_max'),
    requestCount: integer('request_count').notNull().default(0),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    permissions: text('permissions'),
    metadata: text('metadata')
  },
  (t) => [
    index('apikey_reference_idx').on(t.referenceId),
    index('apikey_key_idx').on(t.key),
    index('apikey_config_idx').on(t.configId)
  ]
)

// --- Application tables ------------------------------------------------------

export const organization = pgTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow()
})

export const project = pgTable(
  'project',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow()
  },
  (t) => [uniqueIndex('project_org_slug_uq').on(t.orgId, t.slug)]
)

// Immutable. `serial` and `lineage` are read from the state file for display
// only and are tolerated as absent — see spec §12.
export const stateVersion = pgTable(
  'state_version',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    serial: bigint('serial', { mode: 'number' }),
    lineage: text('lineage'),
    sizeBytes: integer('size_bytes').notNull(),
    md5: text('md5').notNull(),
    blobKey: text('blob_key').notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow()
  },
  (t) => [index('state_version_project_created_idx').on(t.projectId, t.createdAt)]
)

// The pointer. `onDelete: 'restrict'` is what stops retention from pruning the
// version a project currently points at.
export const projectState = pgTable('project_state', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => project.id, { onDelete: 'cascade' }),
  currentVersionId: text('current_version_id')
    .notNull()
    .references(() => stateVersion.id, { onDelete: 'restrict' }),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

// Row exists <=> lock held. The primary key is the whole locking mechanism:
// INSERT ... ON CONFLICT DO NOTHING is atomic and survives process death.
export const stateLock = pgTable('state_lock', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => project.id, { onDelete: 'cascade' }),
  lockId: text('lock_id').notNull(),
  who: text('who'),
  operation: text('operation'),
  version: text('version'),
  infoJson: jsonb('info_json').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow()
})

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    projectId: text('project_id'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    metaJson: jsonb('meta_json'),
    at: timestamp('at').notNull().defaultNow()
  },
  (t) => [index('audit_log_project_at_idx').on(t.projectId, t.at)]
)

// --- Variables (variables spec §3) ------------------------------------------

export const environment = pgTable(
  'environment',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow()
  },
  (t) => [uniqueIndex('environment_project_slug_uq').on(t.projectId, t.slug)]
)

// `valueSealed` is base64 text, not bytea: Neon's HTTP driver sends parameters
// as JSON and returns bytea as a `\x…` string, so a binary column would need
// conversion per driver in both directions (variables spec §3).
export const variable = pgTable(
  'variable',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    valueSealed: text('value_sealed').notNull(),
    sensitive: boolean('sensitive').notNull().default(true),
    description: text('description'),
    updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  },
  (t) => [uniqueIndex('variable_environment_name_uq').on(t.environmentId, t.name)]
)

export const githubInstallation = pgTable('github_installation', {
  installationId: bigint('installation_id', { mode: 'number' }).primaryKey(),
  accountLogin: text('account_login').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow()
})

// `declared` is a column, not a table, so a sync replaces it and its metadata
// in one UPDATE — Neon HTTP has no transactions (variables spec §3).
export const repositoryLink = pgTable(
  'repository_link',
  {
    environmentId: text('environment_id')
      .primaryKey()
      .references(() => environment.id, { onDelete: 'cascade' }),
    installationId: bigint('installation_id', { mode: 'number' })
      .notNull()
      .references(() => githubInstallation.installationId, { onDelete: 'cascade' }),
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    repoFullName: text('repo_full_name').notNull(),
    ref: text('ref').notNull(),
    directory: text('directory').notNull().default(''),
    lastSyncedAt: timestamp('last_synced_at'),
    lastSyncedSha: text('last_synced_sha'),
    lastSyncError: text('last_sync_error'),
    declared: jsonb('declared').$type<DeclaredVariable[]>()
  },
  (t) => [index('repository_link_repo_ref_idx').on(t.repoId, t.ref)]
)

export const schema = {
  user,
  session,
  account,
  verification,
  apikey,
  organization,
  project,
  stateVersion,
  projectState,
  stateLock,
  auditLog,
  environment,
  variable,
  githubInstallation,
  repositoryLink
}
