import { sql } from 'drizzle-orm';
import { CREDENTIAL_KINDS, CREDENTIAL_STATUSES } from './credential-kinds';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    /** Phase 2 tenant that owns this connector account (null = not linked, nothing is mirrored). Set by an admin key only. */
    shopId: text('shop_id').references(() => shops.id),
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

/** Tenant root (Phase 2). Every future shop-owned table must reference `shops.id`. Unrelated to `storeAccounts` (Instagram connector accounts) until a later feature links them. */
export const shops = sqliteTable(
  'shops',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    defaultCurrency: text('default_currency').notNull().default('UAH'),
    defaultLanguage: text('default_language').notNull().default('uk'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('shops_slug_uq').on(t.slug)],
);

/** Dashboard users (Phase 2). Unrelated to Phase 1 `apiKeys`, which authenticate connector clients. */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** Lowercased, trimmed. */
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    /** scrypt hash string; never plaintext. */
    passwordHash: text('password_hash').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const memberships = sqliteTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner', 'manager'] }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('memberships_shop_user_uq').on(t.shopId, t.userId), index('memberships_user_idx').on(t.userId)],
);

export const userSessions = sqliteTable(
  'user_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /** sha256 of the bearer token; the token itself is never stored. */
    hashedToken: text('hashed_token').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => [uniqueIndex('user_sessions_hash_uq').on(t.hashedToken), index('user_sessions_user_idx').on(t.userId)],
);

/** Catalog (Phase 2). Prices are integer minor units (kopiykas for UAH). Every row carries shop_id. */
export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    /** Opaque media references (URLs or storage keys); Hepson does not host media yet. */
    media: text('media', { mode: 'json' }).$type<string[]>().notNull(),
    /** Lowercased name + description + SKUs + option values (JS-folded so Cyrillic matches case-insensitively). */
    searchText: text('search_text').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('products_shop_idx').on(t.shopId, t.createdAt), check('products_price_nonneg', sql`${t.priceMinor} >= 0`)],
);

export const productVariants = sqliteTable(
  'product_variants',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    /** Uppercased; unique per shop. */
    sku: text('sku').notNull(),
    /** e.g. {"size":"M","color":"black"}; {} for a product's default (single) variant. */
    options: text('options', { mode: 'json' }).$type<Record<string, string>>().notNull(),
    /** null = use the product price. */
    priceMinor: integer('price_minor'),
    stock: integer('stock').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('variants_shop_sku_uq').on(t.shopId, t.sku),
    index('variants_product_idx').on(t.productId),
    check('variants_stock_nonneg', sql`${t.stock} >= 0`),
    check('variants_price_nonneg', sql`${t.priceMinor} is null or ${t.priceMinor} >= 0`),
  ],
);

/**
 * Customers, conversations and messages (Phase 2, tenant-owned). Distinct from Phase 1 `conversations` / `messages`,
 * which belong to a connector account; Feature 5 maps connector data into these tables. Every row carries shop_id.
 */
export const customers = sqliteTable(
  'customers',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    /** Channel key, e.g. `instagram` or `website`. */
    channel: text('channel').notNull(),
    /** Channel-specific user id (opaque). */
    externalId: text('external_id').notNull(),
    displayName: text('display_name'),
    handle: text('handle'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('customers_shop_channel_ext_uq').on(t.shopId, t.channel, t.externalId), index('customers_shop_idx').on(t.shopId, t.createdAt)],
);

export const shopConversations = sqliteTable(
  'shop_conversations',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    channel: text('channel').notNull(),
    /** Channel-specific conversation/thread id (opaque). */
    externalId: text('external_id').notNull(),
    status: text('status', { enum: ['open', 'closed'] })
      .notNull()
      .default('open'),
    lastMessageAt: text('last_message_at'),
    /** Human takeover (Feature 8): while true the AI agent stays silent in this conversation. */
    aiPaused: integer('ai_paused', { mode: 'boolean' }).notNull().default(false),
    aiPausedAt: text('ai_paused_at'),
    aiPausedByUserId: text('ai_paused_by_user_id').references(() => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('shop_conv_shop_channel_ext_uq').on(t.shopId, t.channel, t.externalId),
    index('shop_conv_last_idx').on(t.shopId, t.lastMessageAt),
    index('shop_conv_customer_idx').on(t.customerId),
  ],
);

export const shopMessages = sqliteTable(
  'shop_messages',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => shopConversations.id),
    /** Channel message id; null for an outbound message not yet acknowledged. Unique per conversation when present. */
    externalId: text('external_id'),
    direction: text('direction', { enum: ['incoming', 'outgoing'] }).notNull(),
    /** incoming => customer; outgoing => ai | human | system. */
    senderType: text('sender_type', { enum: ['customer', 'ai', 'human', 'system'] }).notNull(),
    /** Dashboard user who sent a `human` message. */
    senderUserId: text('sender_user_id').references(() => users.id),
    text: text('text'),
    attachments: text('attachments', { mode: 'json' }).$type<Array<{ kind: string; url?: string; name?: string }>>().notNull(),
    /** received (incoming) | pending -> sent | failed | uncertain (outgoing). Never set `sent` without a real acknowledgement. */
    deliveryStatus: text('delivery_status', { enum: ['received', 'pending', 'sent', 'failed', 'uncertain'] }).notNull(),
    deliveryError: text('delivery_error'),
    /** Per-conversation order, assigned on insert. */
    seq: integer('seq').notNull(),
    /** When the message happened according to the channel, else ingest time. */
    occurredAt: text('occurred_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('shop_msg_conv_ext_uq').on(t.conversationId, t.externalId),
    uniqueIndex('shop_msg_conv_seq_uq').on(t.conversationId, t.seq),
    index('shop_msg_shop_idx').on(t.shopId, t.createdAt),
    check('shop_msg_sender_dir', sql`(${t.direction} = 'incoming' and ${t.senderType} = 'customer') or (${t.direction} = 'outgoing' and ${t.senderType} <> 'customer')`),
    check('shop_msg_human_user', sql`${t.senderUserId} is null or ${t.senderType} = 'human'`),
  ],
);

/** Per-shop AI switch and extra instructions (Feature 6). Absent row = AI off. */
export const shopAiSettings = sqliteTable('shop_ai_settings', {
  shopId: text('shop_id')
    .primaryKey()
    .references(() => shops.id),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  /** Owner-written tone/policy notes appended to the agent prompt. */
  instructions: text('instructions').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
});

/** Where a shop gets notified (Feature 8). Absent row or null chat id = no notifications. */
export const shopNotifySettings = sqliteTable('shop_notify_settings', {
  shopId: text('shop_id')
    .primaryKey()
    .references(() => shops.id),
  /** Telegram chat the shared bot posts to (numeric id or @channelname). */
  telegramChatId: text('telegram_chat_id'),
  updatedAt: text('updated_at').notNull(),
});

/** Website chat channel of a shop (Feature 10). Absent row or `enabled=false` = the widget key answers 404. */
export const webChatConfigs = sqliteTable('web_chat_configs', {
  shopId: text('shop_id')
    .primaryKey()
    .references(() => shops.id),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  /** Public identifier embedded in the widget snippet. Not a secret: origin checks and visitor tokens protect the chat. */
  widgetKey: text('widget_key').notNull(),
  /** Exact origins (scheme://host[:port]) allowed to embed the widget. Empty = nobody. */
  allowedOrigins: text('allowed_origins', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  updatedAt: text('updated_at').notNull(),
}, (t) => [uniqueIndex('web_chat_key_uq').on(t.widgetKey)]);

/** Anonymous visitor session: the opaque token (sha256 stored) is the visitor's only credential. */
export const webChatSessions = sqliteTable(
  'web_chat_sessions',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    /** Customer and conversation external id on channel `website`. */
    visitorId: text('visitor_id').notNull(),
    displayName: text('display_name'),
    tokenHash: text('token_hash').notNull(),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [uniqueIndex('web_chat_session_token_uq').on(t.tokenHash), index('web_chat_session_shop_idx').on(t.shopId, t.expiresAt)],
);

/** One agent run per inbound message that triggered it (unique) = audit trail and source for AI statistics. */
export const aiRuns = sqliteTable(
  'ai_runs',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => shopConversations.id),
    triggerMessageId: text('trigger_message_id')
      .notNull()
      .references(() => shopMessages.id),
    status: text('status', { enum: ['running', 'replied', 'send_uncertain', 'escalated', 'skipped', 'superseded', 'failed'] }).notNull(),
    model: text('model'),
    modelRequests: integer('model_requests').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    replyMessageId: text('reply_message_id').references(() => shopMessages.id),
    /** Short machine code or reason (no customer text, no secrets). */
    detail: text('detail'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [uniqueIndex('ai_runs_trigger_uq').on(t.triggerMessageId), index('ai_runs_shop_idx').on(t.shopId, t.createdAt)],
);

/** The agent (or a human) asks for human attention. While one is open the agent stays silent in that conversation. */
export const escalations = sqliteTable(
  'escalations',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => shopConversations.id),
    runId: text('run_id').references(() => aiRuns.id),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['open', 'resolved'] })
      .notNull()
      .default('open'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
    resolvedByUserId: text('resolved_by_user_id').references(() => users.id),
  },
  (t) => [index('escalations_shop_idx').on(t.shopId, t.status, t.createdAt), index('escalations_conv_idx').on(t.conversationId, t.status)],
);

/**
 * Order drafts (Feature 7). The AI can only create `pending_approval` drafts; a shop member approves or rejects.
 * Items snapshot name/options/price at draft time so later catalog edits do not rewrite the draft.
 */
export const orderDrafts = sqliteTable(
  'order_drafts',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => shopConversations.id),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    status: text('status', { enum: ['pending_approval', 'approved', 'rejected', 'cancelled'] }).notNull(),
    createdBy: text('created_by', { enum: ['ai', 'user'] }).notNull(),
    runId: text('run_id').references(() => aiRuns.id),
    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    deliveryInfo: text('delivery_info'),
    note: text('note'),
    currency: text('currency').notNull(),
    totalMinor: integer('total_minor').notNull(),
    decidedByUserId: text('decided_by_user_id').references(() => users.id),
    decidedAt: text('decided_at'),
    decisionNote: text('decision_note'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('order_drafts_shop_idx').on(t.shopId, t.status, t.createdAt), index('order_drafts_conv_idx').on(t.conversationId, t.status), check('order_drafts_total_nonneg', sql`${t.totalMinor} >= 0`)],
);

export const orderDraftItems = sqliteTable(
  'order_draft_items',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    draftId: text('draft_id')
      .notNull()
      .references(() => orderDrafts.id),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    variantId: text('variant_id')
      .notNull()
      .references(() => productVariants.id),
    sku: text('sku').notNull(),
    productName: text('product_name').notNull(),
    options: text('options', { mode: 'json' }).$type<Record<string, string>>().notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceMinor: integer('unit_price_minor').notNull(),
  },
  (t) => [index('order_items_draft_idx').on(t.draftId), check('order_items_qty_pos', sql`${t.quantity} > 0`)],
);

/**
 * Per-shop provider secrets (D28), envelope-encrypted: the secret is sealed with a random data key, the data key is
 * wrapped with the master key from the environment. Both seals are AES-256-GCM with AAD = shop id, kind and row id.
 * No plaintext column exists and none may be added. One row per (shop, kind): a new save overwrites the old one.
 */
export const shopCredentials = sqliteTable(
  'shop_credentials',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    kind: text('kind', { enum: CREDENTIAL_KINDS }).notNull(),
    status: text('status', { enum: CREDENTIAL_STATUSES }).notNull(),
    keyVersion: integer('key_version').notNull(),
    wrappedKey: text('wrapped_key').notNull(),
    wrapNonce: text('wrap_nonce').notNull(),
    wrapTag: text('wrap_tag').notNull(),
    nonce: text('nonce').notNull(),
    ciphertext: text('ciphertext').notNull(),
    tag: text('tag').notNull(),
    createdAt: text('created_at').notNull(),
    rotatedAt: text('rotated_at'),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
  },
  (t) => [uniqueIndex('shop_cred_shop_kind_uq').on(t.shopId, t.kind), index('shop_cred_version_idx').on(t.keyVersion)],
);

/** A shop's connected Instagram professional account (D23). Only non-secret references; the token lives in `shop_credentials`. */
export const instagramChannels = sqliteTable(
  'instagram_channels',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    /** Instagram professional account id: the `entry.id` of webhook events. Linked to one shop only. */
    igUserId: text('ig_user_id').notNull(),
    username: text('username'),
    status: text('status', { enum: ['connected', 'needs_reconnect'] }).notNull(),
    tokenExpiresAt: text('token_expires_at'),
    tokenRefreshedAt: text('token_refreshed_at'),
    /** Polling cursor: newest message time already ingested through the Conversations API (null until the first poll). */
    polledUntil: text('polled_until'),
    /** Short code only (never provider text). */
    lastError: text('last_error'),
    connectedAt: text('connected_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('ig_channel_shop_uq').on(t.shopId), uniqueIndex('ig_channel_user_uq').on(t.igUserId)],
);

/** Single-use OAuth `state` (sha256 stored) bound to the logged-in user and the shop that started the connect flow. */
export const instagramOauthStates = sqliteTable(
  'instagram_oauth_states',
  {
    stateHash: text('state_hash').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [index('ig_state_exp_idx').on(t.expiresAt)],
);

/**
 * Official Telegram channel (P2, D27): one shop's own bot. The bot token lives only in `shop_credentials`
 * (`telegram_bot`); the webhook header value is stored as a sha256 hash, so this table holds nothing usable.
 */
export const telegramChannels = sqliteTable(
  'telegram_channels',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    /** Telegram user id of the bot (from `getMe`). One bot serves one shop only. */
    botId: text('bot_id').notNull(),
    botUsername: text('bot_username'),
    /** Opaque random path segment of the webhook URL (never the token). */
    webhookId: text('webhook_id').notNull(),
    /** sha256 of the `secret_token` given to `setWebhook` (Telegram echoes it in a header on every delivery). */
    webhookAuthHash: text('webhook_auth_hash').notNull(),
    status: text('status', { enum: ['connected', 'needs_reconnect'] }).notNull(),
    /** Short code only (never provider text). */
    lastError: text('last_error'),
    connectedAt: text('connected_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('tg_channel_shop_uq').on(t.shopId), uniqueIndex('tg_channel_bot_uq').on(t.botId), uniqueIndex('tg_channel_webhook_uq').on(t.webhookId)],
);
