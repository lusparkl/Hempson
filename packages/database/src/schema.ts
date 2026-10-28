import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// NOTE: no column here may ever hold cookies, tokens, passwords, 2FA secrets or profile bytes.
// Browser auth state lives only in the protected per-account user-data directory.

export const storeAccounts = accountsTable();
function accountsTable() {
  return sqliteTable('store_accounts', {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    connectorType: text('connector_type', { enum: ['mock', 'instagram-browser', 'instagram-official'] }).notNull(),
    status: text('status').notNull().default('disconnected'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    outboundEnabled: integer('outbound_enabled', { mode: 'boolean' }).notNull().default(false),
    consentRecordedAt: text('consent_recorded_at'),
    expectedInstagramHandle: text('expected_instagram_handle'),
    lastAuthValidatedAt: text('last_auth_validated_at'),
    lastErrorCode: text('last_error_code'),
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  });
}

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    /** null = admin key (all accounts); otherwise scoped to exactly one account. */
    accountId: text('account_id').references(() => storeAccounts.id),
    name: text('name').notNull(),
    hashedKey: text('hashed_key').notNull(),
    createdAt: text('created_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => [uniqueIndex('api_keys_hash_uq').on(t.hashedKey)],
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => storeAccounts.id),
    providerId: text('provider_id'),
    participants: text('participants', { mode: 'json' }).$type<string[]>().notNull(),
    title: text('title').notNull(),
    lastObservedAt: text('last_observed_at').notNull(),
    lastMessageAt: text('last_message_at'),
    unread: integer('unread', { mode: 'boolean' }),
  },
  (t) => [uniqueIndex('conv_account_provider_uq').on(t.accountId, t.providerId), index('conv_account_last_idx').on(t.accountId, t.lastMessageAt)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => storeAccounts.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    providerId: text('provider_id'),
    fingerprint: text('fingerprint').notNull(),
    direction: text('direction', { enum: ['incoming', 'outgoing'] }).notNull(),
    senderDisplayName: text('sender_display_name'),
    text: text('text'),
    attachments: text('attachments', { mode: 'json' }).$type<Array<{ kind: string; metadata?: unknown }>>().notNull(),
    sentAt: text('sent_at'),
    observedAt: text('observed_at').notNull(),
    seq: integer('seq').notNull(),
    deliveryStatus: text('delivery_status').notNull(),
  },
  (t) => [uniqueIndex('msg_account_fp_uq').on(t.accountId, t.fingerprint), index('msg_conv_idx').on(t.accountId, t.conversationId, t.seq)],
);

export const outbox = sqliteTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => storeAccounts.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    idempotencyKey: text('idempotency_key').notNull(),
    body: text('body').notNull(),
    bodyHash: text('body_hash').notNull(),
    status: text('status', { enum: ['queued', 'sending', 'sent', 'uncertain', 'failed'] }).notNull(),
    errorCode: text('error_code'),
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(false),
    reviewedAt: text('reviewed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('outbox_account_idem_uq').on(t.accountId, t.idempotencyKey), index('outbox_status_idx').on(t.accountId, t.status)],
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => storeAccounts.id),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    occurredAt: text('occurred_at').notNull(),
    sequence: integer('sequence').notNull(),
  },
  (t) => [uniqueIndex('events_account_seq_uq').on(t.accountId, t.sequence)],
);

export const connectorState = sqliteTable('connector_state', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => storeAccounts.id),
  lastSyncAt: text('last_sync_at'),
  lastError: text('last_error'),
  syncCursor: text('sync_cursor'),
  /** 1 once the first full sync completed; later new messages are "new", earlier ones are backfill. */
  baselineDone: integer('baseline_done', { mode: 'boolean' }).notNull().default(false),
});
