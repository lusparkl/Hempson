import { sql } from 'drizzle-orm';
import { CREDENTIAL_KINDS, CREDENTIAL_STATUSES } from './credential-kinds';
import { CUSTOMER_NOTICE_EVENTS, CUSTOMER_NOTICE_STATES, ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_PROVIDERS, PAYMENT_STATES, PLAN_NAMES, POLICY_TOPICS } from './order-kinds';
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
  /** D26: who approves AI drafts. Only an owner changes it; the last change is recorded below. */
  autonomy: text('autonomy', { enum: ['approval_required', 'auto_confirm'] }).notNull().default('approval_required'),
  /** Optional `auto_confirm` cap on the order total (minor units); null = no cap. */
  autoConfirmMaxMinor: integer('auto_confirm_max_minor'),
  autonomyChangedAt: text('autonomy_changed_at'),
  autonomyChangedBy: text('autonomy_changed_by').references(() => users.id),
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
    status: text('status', { enum: ORDER_STATUSES }).notNull(),
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
    /** Set once when the order is approved (by a member or `system:auto_confirm`); stats count approvals by it. */
    approvedAt: text('approved_at'),
    /** Checkout data (P4). Approval requires all of it; the NP refs come only from Nova Poshta lookups. */
    recipientFirstName: text('recipient_first_name'),
    recipientLastName: text('recipient_last_name'),
    /** Normalized `+380XXXXXXXXX`. */
    recipientPhone: text('recipient_phone'),
    npCityRef: text('np_city_ref'),
    npCityName: text('np_city_name'),
    npWarehouseRef: text('np_warehouse_ref'),
    npWarehouseName: text('np_warehouse_name'),
    paymentMethod: text('payment_method', { enum: PAYMENT_METHODS }),
    /**
     * TTN creation guard (at most once per order): `creating` is claimed before the NP call; `uncertain` = the call may
     * have created a parcel, never retried automatically; `failed` = NP refused it, a member may retry.
     */
    ttnState: text('ttn_state', { enum: ['creating', 'created', 'failed', 'uncertain'] }),
    ttnError: text('ttn_error'),
    /** TTN number and document ref exactly as Nova Poshta returned them. */
    ttn: text('ttn'),
    npDocumentRef: text('np_document_ref'),
    npStatusCode: text('np_status_code'),
    npStatusText: text('np_status_text'),
    npStatusAt: text('np_status_at'),
    /** P5: an `awaiting_payment` order is cancelled with restock at this time (set on entering the state, per-shop timeout). */
    paymentDueAt: text('payment_due_at'),
    /** P5: the one payment reminder (or the shop notice instead of it) was claimed at this time. */
    paymentReminderAt: text('payment_reminder_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('order_drafts_shop_idx').on(t.shopId, t.status, t.createdAt),
    index('order_drafts_conv_idx').on(t.conversationId, t.status),
    uniqueIndex('order_drafts_ttn_uq').on(t.shopId, t.ttn),
    check('order_drafts_total_nonneg', sql`${t.totalMinor} >= 0`),
  ],
);

/** Every order status change (D25 audit): who or what (`user:<id>`, `ai`, `system:auto_confirm`, `provider:nova_poshta`), from, to, when. */
export const orderEvents = sqliteTable(
  'order_events',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    draftId: text('draft_id')
      .notNull()
      .references(() => orderDrafts.id),
    fromStatus: text('from_status', { enum: ORDER_STATUSES }),
    toStatus: text('to_status', { enum: ORDER_STATUSES }).notNull(),
    actor: text('actor').notNull(),
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('order_events_draft_idx').on(t.draftId, t.createdAt), index('order_events_shop_idx').on(t.shopId, t.createdAt)],
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

/** Shop policy texts the agent may quote (P3). One row per (shop, topic); `version` grows on every save. */
export const shopPolicies = sqliteTable(
  'shop_policies',
  {
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    topic: text('topic', { enum: POLICY_TOPICS }).notNull(),
    text: text('text').notNull(),
    version: integer('version').notNull(),
    updatedByUserId: text('updated_by_user_id').references(() => users.id),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('shop_policies_uq').on(t.shopId, t.topic)],
);

/** Nova Poshta sender and checkout settings of a shop (P4). The API key itself is in `shop_credentials` (kind `nova_poshta`). */
export const shopDeliverySettings = sqliteTable('shop_delivery_settings', {
  shopId: text('shop_id')
    .primaryKey()
    .references(() => shops.id),
  /** Sender counterparty and contact person refs, read from NP when the key is saved. */
  senderRef: text('sender_ref'),
  senderContactRef: text('sender_contact_ref'),
  senderPhone: text('sender_phone'),
  senderCityRef: text('sender_city_ref'),
  senderCityName: text('sender_city_name'),
  senderWarehouseRef: text('sender_warehouse_ref'),
  senderWarehouseName: text('sender_warehouse_name'),
  codEnabled: integer('cod_enabled', { mode: 'boolean' }).notNull().default(true),
  /** Prepaid is offered only while a payment provider is connected as well (P5). */
  prepaidEnabled: integer('prepaid_enabled', { mode: 'boolean' }).notNull().default(false),
  /** D25: refused COD parcels per customer before COD stops being offered (0 = rule off). */
  refusalLimit: integer('refusal_limit').notNull().default(1),
  parcelWeightKg: text('parcel_weight_kg').notNull().default('1'),
  parcelDescription: text('parcel_description').notNull().default('Товар'),
  /** Short code only (never provider text). */
  lastError: text('last_error'),
  updatedAt: text('updated_at').notNull(),
});

/** Refused parcels per customer (D25), counted per shop by normalized phone, else by customer id. Never shared across shops. */
export const customerRefusals = sqliteTable(
  'customer_refusals',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    customerId: text('customer_id').references(() => customers.id),
    phone: text('phone'),
    /** The order whose parcel was refused; unique so NP polling counts one refusal per order. */
    draftId: text('draft_id').references(() => orderDrafts.id),
    source: text('source', { enum: ['nova_poshta', 'member'] }).notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('refusals_shop_phone_idx').on(t.shopId, t.phone), index('refusals_shop_customer_idx').on(t.shopId, t.customerId), uniqueIndex('refusals_draft_uq').on(t.draftId)],
);

/**
 * Payment settings of a shop (P5, D24). The provider token itself is in `shop_credentials` (kind `monobank`). The
 * webhook id is the opaque path segment of this shop's webhook URL; the public key verifies Monobank's `x-sign`.
 */
export const shopPaymentSettings = sqliteTable(
  'shop_payment_settings',
  {
    shopId: text('shop_id')
      .primaryKey()
      .references(() => shops.id),
    webhookId: text('webhook_id'),
    /** Monobank merchant identity from `/api/merchant/details` (not secret). */
    merchantId: text('merchant_id'),
    merchantName: text('merchant_name'),
    /** Monobank's ECDSA public key as the API returned it (base64 of a PEM block). Public, cached until a signature fails. */
    providerPubKey: text('provider_pub_key'),
    providerPubKeyAt: text('provider_pub_key_at'),
    /** D25: an unpaid order is cancelled after this many hours; one reminder this many hours before (0 = none). */
    paymentTimeoutHours: integer('payment_timeout_hours').notNull().default(24),
    reminderHoursBefore: integer('reminder_hours_before').notNull().default(6),
    /** Short code only (never provider text). */
    lastError: text('last_error'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('shop_payment_settings_webhook_uq').on(t.webhookId)],
);

/**
 * Payment link attempts of an order (P5). At most one active attempt per order (partial unique index); amounts are the
 * order total in minor units as sent to the provider. Status changes only from a verified webhook or a status call.
 */
export const orderPayments = sqliteTable(
  'order_payments',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    draftId: text('draft_id')
      .notNull()
      .references(() => orderDrafts.id),
    provider: text('provider', { enum: PAYMENT_PROVIDERS }).notNull(),
    state: text('state', { enum: PAYMENT_STATES }).notNull(),
    /** 1 while this attempt can still be paid or is paid; 0 once it failed, expired or was removed. */
    active: integer('active', { mode: 'boolean' }).notNull(),
    invoiceId: text('invoice_id'),
    pageUrl: text('page_url'),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    /** Provider `modifiedDate` of the last applied status; older events are ignored. */
    providerModifiedAt: text('provider_modified_at'),
    finalAmountMinor: integer('final_amount_minor'),
    /** Provider failure code (digits/short code only). */
    providerErrCode: text('provider_err_code'),
    /** Hepson's own short code: why creation failed, `AMOUNT_MISMATCH`, `PAID_AFTER_CANCEL`. */
    flag: text('flag'),
    expiresAt: text('expires_at').notNull(),
    /** The fixed-template link message was claimed for sending (once per attempt). */
    linkSentAt: text('link_sent_at'),
    linkDelivery: text('link_delivery'),
    lastCheckedAt: text('last_checked_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('order_payments_draft_idx').on(t.shopId, t.draftId, t.createdAt),
    uniqueIndex('order_payments_invoice_uq').on(t.provider, t.invoiceId),
    uniqueIndex('order_payments_active_uq').on(t.draftId).where(sql`${t.active} = 1`),
    index('order_payments_state_idx').on(t.state, t.lastCheckedAt),
  ],
);

/**
 * Every provider status Hepson received for a payment (P5), verified or not applied. The unique key makes a replayed
 * webhook (same invoice, status and modifiedDate) a no-op. `verdict` says what Hepson did with it.
 */
export const paymentEvents = sqliteTable(
  'payment_events',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    paymentId: text('payment_id').references(() => orderPayments.id),
    provider: text('provider', { enum: PAYMENT_PROVIDERS }).notNull(),
    invoiceId: text('invoice_id').notNull(),
    status: text('status').notNull(),
    providerModifiedAt: text('provider_modified_at').notNull(),
    amountMinor: integer('amount_minor'),
    ccy: integer('ccy'),
    source: text('source', { enum: ['webhook', 'status'] }).notNull(),
    verdict: text('verdict', { enum: ['applied', 'stale', 'mismatch', 'unknown_invoice'] }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('payment_events_uq').on(t.shopId, t.provider, t.invoiceId, t.status, t.providerModifiedAt), index('payment_events_payment_idx').on(t.paymentId, t.createdAt)],
);

/**
 * Customer notices (P6): fixed server texts about an order sent to its customer. The unique key makes each (order,
 * event) one row, written in the same transaction as the status change, so retries and restarts cannot send twice.
 */
export const customerNotices = sqliteTable(
  'customer_notices',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id),
    draftId: text('draft_id')
      .notNull()
      .references(() => orderDrafts.id),
    event: text('event', { enum: CUSTOMER_NOTICE_EVENTS }).notNull(),
    state: text('state', { enum: CUSTOMER_NOTICE_STATES }).notNull(),
    /** Short code: why it failed, was skipped or is uncertain (`OUTSIDE_MESSAGING_WINDOW`, `STALE`, ...). */
    code: text('code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('customer_notices_uq').on(t.draftId, t.event), index('customer_notices_state_idx').on(t.state, t.createdAt), index('customer_notices_shop_idx').on(t.shopId, t.draftId)],
);

/**
 * A shop's Hepson plan (P7), set by the operator. No row means the server's default plan. `customCap` overrides the
 * plan's cap. `capNoticeMonth` is the UTC month (`YYYY-MM`) whose cap notice the owner already got (once per month).
 */
export const shopPlans = sqliteTable('shop_plans', {
  shopId: text('shop_id')
    .primaryKey()
    .references(() => shops.id),
  plan: text('plan', { enum: PLAN_NAMES as [string, ...string[]] }).notNull(),
  customCap: integer('custom_cap'),
  capNoticeMonth: text('cap_notice_month'),
  updatedAt: text('updated_at').notNull(),
});
