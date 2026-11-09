import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import { isUniqueViolation, queryRow, queryRows } from './dialect';
import * as t from './schema';

export type CustomerRow = typeof t.customers.$inferSelect;
export type ShopConversationRow = typeof t.shopConversations.$inferSelect;
export type ShopMessageRow = typeof t.shopMessages.$inferSelect;
export type ConversationWithCustomer = { conversation: ShopConversationRow; customer: CustomerRow };
export type DeliveryStatus = ShopMessageRow['deliveryStatus'];
/** P10 list preview: the newest customer, AI or human message of a conversation (system lines are skipped). */
export type LastMessage = { text: string | null; senderType: ShopMessageRow['senderType']; attachments: number; at: string };
/** P10 customer card: phone and city from the customer's newest order that has them; orders across conversations (`count` all, `placed` and `totals` without rejected or cancelled ones). */
export type CustomerProfile = {
  phone: string | null;
  city: string | null;
  orders: { count: number; placed: number; totals: Array<{ currency: string; totalMinor: number }>; lastAt: string | null };
};

/** Statuses that do not count as a placed order in the customer card. */
const NOT_PLACED = ['rejected', 'cancelled'];
const NOTE_MAX = 2000;

export class ConversationValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid conversation input: ${issues.join('; ')}`);
    this.name = 'ConversationValidationError';
  }
}
export class ConversationNotFoundError extends Error {
  constructor(what: 'conversation' | 'message' | 'customer') {
    super(`${what} not found`);
    this.name = 'ConversationNotFoundError';
  }
}
/** The channel ids contradict stored data (e.g. a conversation id that belongs to another customer). */
export class ConversationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationConflictError';
  }
}

const channel = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/, 'lowercase channel key, e.g. instagram');
const externalId = z.string().trim().min(1).max(256);
const isoTime = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());
const attachments = z
  .array(
    z.strictObject({ kind: z.string().trim().min(1).max(40), url: z.string().max(2048).optional(), name: z.string().max(200).optional(), ref: z.string().max(2048).optional() }),
  )
  .max(20)
  .default([]);
const messageText = z.string().max(10_000).nullish();

const customerInput = z.strictObject({ externalId, displayName: z.string().trim().max(200).nullish(), handle: z.string().trim().max(100).nullish() });
const hasContent = (v: { text?: string | null; attachments: unknown[] }) => !!v.text?.trim() || v.attachments.length > 0;

const ingestInput = z
  .strictObject({
    channel,
    conversationExternalId: externalId,
    customer: customerInput,
    externalId,
    text: messageText,
    attachments,
    occurredAt: isoTime.optional(),
  })
  .refine(hasContent, 'message needs text or an attachment');

const outboundInput = z
  .strictObject({
    senderType: z.enum(['ai', 'human', 'system']),
    /** Only for `human`, and optional there: a human reply made outside Hepson (e.g. in the Instagram app) has no known user. Must be a member of the shop. */
    senderUserId: z.uuid().optional(),
    text: messageText,
    attachments,
    /** Set when the message is already known to the channel (observed, or acknowledged). */
    externalId: externalId.optional(),
    deliveryStatus: z.enum(['pending', 'sent', 'uncertain']).default('pending'),
    occurredAt: isoTime.optional(),
  })
  .refine(hasContent, 'message needs text or an attachment')
  .refine((v) => v.senderUserId === undefined || v.senderType === 'human', 'senderUserId applies only to human messages')
  .refine((v) => v.deliveryStatus !== 'sent' || v.externalId !== undefined, '"sent" requires the channel message id (no fabricated acknowledgements)');

const deliveryUpdate = z.strictObject({ externalId: externalId.optional(), error: z.string().max(1000).optional() });

export type IngestMessageInput = z.input<typeof ingestInput>;
export type RecordOutboundInput = z.input<typeof outboundInput>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ConversationValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
  return r.data;
}
const page = (limit: number | undefined, def: number, max: number) => Math.min(Math.max(Math.trunc(limit ?? def), 1), max);

/** From -> allowed next delivery states. Incoming (`received`), `sent` and `failed` are final. */
const TRANSITIONS: Partial<Record<DeliveryStatus, DeliveryStatus[]>> = { pending: ['sent', 'failed', 'uncertain'], uncertain: ['sent', 'failed'] };

/**
 * Shop-scoped customers, conversations and messages. Every method takes `shopId` first and filters by it,
 * including lookups by id, so an id from another shop is simply "not found". Internal: no authorization here.
 */
export class ConversationRepository {
  readonly db: Db;
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }
  private now() {
    return this.clock().toISOString();
  }

  private upsertCustomer(shopId: string, ch: string, c: z.output<typeof customerInput>): CustomerRow {
    const ts = this.now();
    const found = this.db
      .select()
      .from(t.customers)
      .where(and(eq(t.customers.shopId, shopId), eq(t.customers.channel, ch), eq(t.customers.externalId, c.externalId)))
      .get();
    if (!found) {
      const row: CustomerRow = {
        id: randomUUID(),
        shopId,
        channel: ch,
        externalId: c.externalId,
        displayName: c.displayName || null,
        handle: c.handle || null,
        note: null,
        noteUpdatedAt: null,
        noteUpdatedByUserId: null,
        createdAt: ts,
        updatedAt: ts,
      };
      this.db.insert(t.customers).values(row).run();
      return row;
    }
    const displayName = c.displayName || found.displayName;
    const handle = c.handle || found.handle;
    if (displayName === found.displayName && handle === found.handle) return found;
    return this.db.update(t.customers).set({ displayName, handle, updatedAt: ts }).where(eq(t.customers.id, found.id)).returning().get()!;
  }

  private conversationFor(shopId: string, ch: string, extId: string, customer: CustomerRow): ShopConversationRow {
    const found = this.db
      .select()
      .from(t.shopConversations)
      .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.channel, ch), eq(t.shopConversations.externalId, extId)))
      .get();
    if (found) {
      if (found.customerId !== customer.id) throw new ConversationConflictError('conversation id already belongs to a different customer');
      return found;
    }
    const ts = this.now();
    const row: ShopConversationRow = {
      id: randomUUID(),
      shopId,
      customerId: customer.id,
      channel: ch,
      externalId: extId,
      status: 'open',
      lastMessageAt: null,
      aiPaused: false,
      aiPausedAt: null,
      aiPausedByUserId: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db.insert(t.shopConversations).values(row).run();
    return row;
  }

  /** Idempotent on (conversation, externalId): a repeat returns the stored row and changes nothing. */
  private insertMessage(
    shopId: string,
    conv: ShopConversationRow,
    m: Pick<ShopMessageRow, 'externalId' | 'direction' | 'senderType' | 'senderUserId' | 'deliveryStatus'> & {
      text?: string | null;
      attachments: ShopMessageRow['attachments'];
      occurredAt?: string;
    },
  ): { message: ShopMessageRow; duplicated: boolean } {
    if (m.externalId) {
      const dup = this.db
        .select()
        .from(t.shopMessages)
        .where(and(eq(t.shopMessages.shopId, shopId), eq(t.shopMessages.conversationId, conv.id), eq(t.shopMessages.externalId, m.externalId)))
        .get();
      if (dup) return { message: dup, duplicated: true };
    }
    const ts = this.now();
    const seq =
      this.db
        .select({ n: sql<number>`coalesce(max(${t.shopMessages.seq}), 0)` })
        .from(t.shopMessages)
        .where(eq(t.shopMessages.conversationId, conv.id))
        .get()!.n + 1;
    const occurredAt = m.occurredAt ?? ts;
    const row: ShopMessageRow = {
      id: randomUUID(),
      shopId,
      conversationId: conv.id,
      externalId: m.externalId,
      direction: m.direction,
      senderType: m.senderType,
      senderUserId: m.senderUserId,
      text: m.text ?? null,
      attachments: m.attachments,
      deliveryStatus: m.deliveryStatus,
      deliveryError: null,
      seq,
      occurredAt,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db.insert(t.shopMessages).values(row).run();
    const last = conv.lastMessageAt && conv.lastMessageAt > occurredAt ? conv.lastMessageAt : occurredAt;
    this.db
      .update(t.shopConversations)
      .set({ lastMessageAt: last, updatedAt: ts, ...(m.direction === 'incoming' ? { status: 'open' as const } : {}) })
      .where(eq(t.shopConversations.id, conv.id))
      .run();
    return { message: row, duplicated: false };
  }

  /** Finds or creates the customer and conversation for a channel thread without storing a message. */
  async ensureConversation(shopId: string, input: { channel: string; conversationExternalId: string; customer: z.input<typeof customerInput> }): Promise<ConversationWithCustomer> {
    const v = parse(z.strictObject({ channel, conversationExternalId: externalId, customer: customerInput }), input);
    return this.handle.transaction(() => {
      const customer = this.upsertCustomer(shopId, v.channel, v.customer);
      const conv = this.conversationFor(shopId, v.channel, v.conversationExternalId, customer);
      return { conversation: conv, customer };
    });
  }

  /** Upserts the customer and conversation, then stores the inbound message once. A new inbound message reopens a closed conversation. */
  async ingestMessage(
    shopId: string,
    input: IngestMessageInput,
  ): Promise<{ message: ShopMessageRow; conversation: ShopConversationRow; customer: CustomerRow; duplicated: boolean }> {
    const v = parse(ingestInput, input);
    return this.handle.transaction(() => {
      const customer = this.upsertCustomer(shopId, v.channel, v.customer);
      const conv = this.conversationFor(shopId, v.channel, v.conversationExternalId, customer);
      const { message, duplicated } = this.insertMessage(shopId, conv, {
        externalId: v.externalId,
        direction: 'incoming',
        senderType: 'customer',
        senderUserId: null,
        deliveryStatus: 'received',
        text: v.text,
        attachments: v.attachments,
        occurredAt: v.occurredAt,
      });
      return { message, duplicated, customer, conversation: this.getConversationTx(shopId, conv.id)!.conversation };
    });
  }

  /** Undoes `ingestMessage` for a new message whose dispatch failed, so a redelivery is not treated as a duplicate. */
  async discardIngested(shopId: string, conversationId: string, messageId: string): Promise<void> {
    this.handle.transaction(() => {
      this.db
        .delete(t.shopMessages)
        .where(and(eq(t.shopMessages.shopId, shopId), eq(t.shopMessages.id, messageId)))
        .run();
      const last = this.db
        .select({ at: sql<string | null>`max(${t.shopMessages.occurredAt})` })
        .from(t.shopMessages)
        .where(eq(t.shopMessages.conversationId, conversationId))
        .get()!.at;
      this.db
        .update(t.shopConversations)
        .set({ lastMessageAt: last, updatedAt: this.now() })
        .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.id, conversationId)))
        .run();
    });
  }

  /** Records an outgoing message: `pending` (to be sent), `sent` (already on the channel, needs its channel id) or `uncertain` (send attempted, outcome unknown). */
  async recordOutbound(shopId: string, conversationId: string, input: RecordOutboundInput): Promise<{ message: ShopMessageRow; duplicated: boolean }> {
    const v = parse(outboundInput, input);
    return this.handle.transaction(() => {
      const conv = this.db
        .select()
        .from(t.shopConversations)
        .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.id, conversationId)))
        .get();
      if (!conv) throw new ConversationNotFoundError('conversation');
      if (v.senderUserId) {
        const member = this.db
          .select({ id: t.memberships.id })
          .from(t.memberships)
          .where(and(eq(t.memberships.shopId, shopId), eq(t.memberships.userId, v.senderUserId)))
          .get();
        if (!member) throw new ConversationValidationError(['senderUserId: not a member of this shop']);
      }
      return this.insertMessage(shopId, conv, {
        externalId: v.externalId ?? null,
        direction: 'outgoing',
        senderType: v.senderType,
        senderUserId: v.senderUserId ?? null,
        deliveryStatus: v.deliveryStatus,
        text: v.text,
        attachments: v.attachments,
        occurredAt: v.occurredAt,
      });
    });
  }

  /** pending -> sent | failed | uncertain; uncertain -> sent | failed. `sent` needs a channel id (given now or already stored). */
  async setDeliveryStatus(shopId: string, messageId: string, status: DeliveryStatus, extra: z.input<typeof deliveryUpdate> = {}): Promise<ShopMessageRow> {
    return this.setDeliveryStatusTx(shopId, messageId, status, extra);
  }

  /** Sync body of `setDeliveryStatus`: runs inside the caller's transaction. Package-internal. */
  setDeliveryStatusTx(shopId: string, messageId: string, status: DeliveryStatus, extra: z.input<typeof deliveryUpdate> = {}): ShopMessageRow {
    const x = parse(deliveryUpdate, extra);
    return this.handle.transaction(() => {
      const m = this.db
        .select()
        .from(t.shopMessages)
        .where(and(eq(t.shopMessages.shopId, shopId), eq(t.shopMessages.id, messageId)))
        .get();
      if (!m) throw new ConversationNotFoundError('message');
      if (!TRANSITIONS[m.deliveryStatus]?.includes(status)) throw new ConversationValidationError([`deliveryStatus: cannot change ${m.deliveryStatus} -> ${status}`]);
      const ext = x.externalId ?? m.externalId;
      if (status === 'sent' && !ext) throw new ConversationValidationError(['externalId: required to mark a message sent']);
      try {
        return this.db
          .update(t.shopMessages)
          .set({ deliveryStatus: status, externalId: ext, deliveryError: status === 'sent' ? null : (x.error ?? null), updatedAt: this.now() })
          .where(eq(t.shopMessages.id, m.id))
          .returning()
          .get()!;
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConversationConflictError('channel message id already stored in this conversation');
        throw e;
      }
    });
  }

  async setConversationStatus(shopId: string, conversationId: string, status: ShopConversationRow['status']): Promise<ShopConversationRow> {
    if (status !== 'open' && status !== 'closed') throw new ConversationValidationError(['status: must be open or closed']);
    const r = this.db
      .update(t.shopConversations)
      .set({ status, updatedAt: this.now() })
      .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.id, conversationId)))
      .returning()
      .get();
    if (!r) throw new ConversationNotFoundError('conversation');
    return r;
  }

  async getCustomer(shopId: string, customerId: string): Promise<CustomerRow | undefined> {
    return this.db
      .select()
      .from(t.customers)
      .where(and(eq(t.customers.shopId, shopId), eq(t.customers.id, customerId)))
      .get();
  }

  async listCustomers(shopId: string, f: { limit?: number; offset?: number } = {}): Promise<{ items: CustomerRow[]; total: number }> {
    const where = eq(t.customers.shopId, shopId);
    const total = this.db
      .select({ n: sql<number>`count(*)` })
      .from(t.customers)
      .where(where)
      .get()!.n;
    const items = this.db
      .select()
      .from(t.customers)
      .where(where)
      .orderBy(desc(t.customers.createdAt), asc(t.customers.id))
      .limit(page(f.limit, 50, 200))
      .offset(Math.max(Math.trunc(f.offset ?? 0), 0))
      .all();
    return { items, total };
  }

  async getConversation(shopId: string, conversationId: string): Promise<ConversationWithCustomer | undefined> {
    return this.getConversationTx(shopId, conversationId);
  }

  /** Sync body of `getConversation`: runs inside the caller's transaction. Package-internal. */
  getConversationTx(shopId: string, conversationId: string): ConversationWithCustomer | undefined {
    const r = this.db
      .select({ conversation: t.shopConversations, customer: t.customers })
      .from(t.shopConversations)
      .innerJoin(t.customers, eq(t.customers.id, t.shopConversations.customerId))
      .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.id, conversationId)))
      .get();
    return r;
  }

  /** Most recently active first. */
  async listConversations(
    shopId: string,
    f: { status?: ShopConversationRow['status']; customerId?: string; limit?: number; offset?: number } = {},
  ): Promise<{ items: ConversationWithCustomer[]; total: number }> {
    const conds = [eq(t.shopConversations.shopId, shopId)];
    if (f.status) conds.push(eq(t.shopConversations.status, f.status));
    if (f.customerId) conds.push(eq(t.shopConversations.customerId, f.customerId));
    const where = and(...conds);
    const total = this.db
      .select({ n: sql<number>`count(*)` })
      .from(t.shopConversations)
      .where(where)
      .get()!.n;
    const items = this.db
      .select({ conversation: t.shopConversations, customer: t.customers })
      .from(t.shopConversations)
      .innerJoin(t.customers, eq(t.customers.id, t.shopConversations.customerId))
      .where(where)
      .orderBy(desc(sql`coalesce(${t.shopConversations.lastMessageAt}, ${t.shopConversations.createdAt})`), asc(t.shopConversations.id))
      .limit(page(f.limit, 50, 200))
      .offset(Math.max(Math.trunc(f.offset ?? 0), 0))
      .all();
    return { items, total };
  }

  /** The newest `limit` messages (before `beforeSeq` when given), returned oldest first. */
  async listMessages(shopId: string, conversationId: string, f: { limit?: number; beforeSeq?: number } = {}): Promise<{ items: ShopMessageRow[]; hasMore: boolean }> {
    if (!this.getConversationTx(shopId, conversationId)) throw new ConversationNotFoundError('conversation');
    const limit = page(f.limit, 50, 200);
    const conds = [eq(t.shopMessages.shopId, shopId), eq(t.shopMessages.conversationId, conversationId)];
    if (f.beforeSeq !== undefined) conds.push(lt(t.shopMessages.seq, f.beforeSeq));
    const rows = this.db
      .select()
      .from(t.shopMessages)
      .where(and(...conds))
      .orderBy(desc(t.shopMessages.seq))
      .limit(limit + 1)
      .all();
    return { hasMore: rows.length > limit, items: rows.slice(0, limit).reverse() };
  }

  async findConversationByExternal(shopId: string, ch: string, extId: string): Promise<ConversationWithCustomer | undefined> {
    return this.db
      .select({ conversation: t.shopConversations, customer: t.customers })
      .from(t.shopConversations)
      .innerJoin(t.customers, eq(t.customers.id, t.shopConversations.customerId))
      .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.channel, ch), eq(t.shopConversations.externalId, extId)))
      .get();
  }

  async findMessageByExternal(shopId: string, conversationId: string, extId: string): Promise<ShopMessageRow | undefined> {
    return this.findMessageByExternalTx(shopId, conversationId, extId);
  }

  /** Sync body of `findMessageByExternal`: runs inside the caller's transaction. Package-internal. */
  findMessageByExternalTx(shopId: string, conversationId: string, extId: string): ShopMessageRow | undefined {
    return this.db
      .select()
      .from(t.shopMessages)
      .where(and(eq(t.shopMessages.shopId, shopId), eq(t.shopMessages.conversationId, conversationId), eq(t.shopMessages.externalId, extId)))
      .get();
  }

  /**
   * The channel now shows an outgoing message with this text and id: give it to the newest still-unacknowledged `ai`
   * message with the same text instead of recording a second row (D11/D12 reconciliation). No-op when that channel id
   * is already stored or no such pending message exists.
   */
  async adoptPendingOutbound(
    shopId: string,
    conversationId: string,
    text: string,
    extId: string,
    status: 'sent' | 'uncertain',
    senderType: 'ai' | 'human' | 'system' = 'ai',
  ): Promise<ShopMessageRow | undefined> {
    return this.handle.transaction(() => {
      if (this.findMessageByExternalTx(shopId, conversationId, extId)) return undefined;
      const pending = this.db
        .select()
        .from(t.shopMessages)
        .where(
          and(
            eq(t.shopMessages.shopId, shopId),
            eq(t.shopMessages.conversationId, conversationId),
            eq(t.shopMessages.direction, 'outgoing'),
            eq(t.shopMessages.senderType, senderType),
            eq(t.shopMessages.deliveryStatus, 'pending'),
            eq(t.shopMessages.text, text.trim()),
            sql`${t.shopMessages.externalId} is null`,
          ),
        )
        .orderBy(desc(t.shopMessages.seq))
        .get();
      return pending && this.setDeliveryStatusTx(shopId, pending.id, status, { externalId: extId });
    });
  }

  /** Human takeover switch (Feature 8). Idempotent: pausing a paused conversation keeps the first pauser and time. */
  async setAiPaused(shopId: string, conversationId: string, paused: boolean, userId: string | null): Promise<ConversationWithCustomer> {
    return this.handle.transaction(() => {
      const cur = this.getConversationTx(shopId, conversationId);
      if (!cur) throw new ConversationNotFoundError('conversation');
      if (cur.conversation.aiPaused === paused) return cur;
      this.db
        .update(t.shopConversations)
        .set(paused ? { aiPaused: true, aiPausedAt: this.now(), aiPausedByUserId: userId } : { aiPaused: false, aiPausedAt: null, aiPausedByUserId: null })
        .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.id, conversationId)))
        .run();
      return this.getConversationTx(shopId, conversationId)!;
    });
  }

  /** When the customer last wrote in this conversation (channel time), or undefined: the start of Instagram's 24-hour window. */
  async lastInboundAt(shopId: string, conversationId: string): Promise<string | undefined> {
    return (
      this.db
        .select({ at: sql<string>`max(${t.shopMessages.occurredAt})` })
        .from(t.shopMessages)
        .where(and(eq(t.shopMessages.shopId, shopId), eq(t.shopMessages.conversationId, conversationId), eq(t.shopMessages.direction, 'incoming')))
        .get()?.at ?? undefined
    );
  }

  async getMessage(shopId: string, messageId: string): Promise<ShopMessageRow | undefined> {
    return this.db
      .select()
      .from(t.shopMessages)
      .where(and(eq(t.shopMessages.shopId, shopId), eq(t.shopMessages.id, messageId)))
      .get();
  }
  /** P10: the newest non-system message of each given conversation of this shop. */
  async lastMessages(shopId: string, conversationIds: string[]): Promise<Map<string, LastMessage>> {
    const out = new Map<string, LastMessage>();
    for (let i = 0; i < conversationIds.length; i += 500) {
      const ids = conversationIds.slice(i, i + 500);
      const rows = this.db
        .select({ c: t.shopMessages.conversationId, text: t.shopMessages.text, s: t.shopMessages.senderType, a: t.shopMessages.attachments, at: t.shopMessages.occurredAt })
        .from(t.shopMessages)
        .where(
          and(
            eq(t.shopMessages.shopId, shopId),
            inArray(t.shopMessages.conversationId, ids),
            sql`${t.shopMessages.seq} = (select max(x.seq) from shop_messages x where x.conversation_id = ${t.shopMessages.conversationId} and x.sender_type <> 'system')`,
          ),
        )
        .all();
      for (const r of rows) out.set(r.c, { text: r.text, senderType: r.s, attachments: r.a.length, at: r.at });
    }
    return out;
  }

  /**
   * P10: which of the given conversations have a customer message this member has not seen (newer than their read
   * marker; no marker = any customer message is unread).
   */
  async unreadFor(shopId: string, userId: string, conversationIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < conversationIds.length; i += 500) {
      const ids = conversationIds.slice(i, i + 500);
      const rows = queryRows<{ id: string }>(
        this.db,
        sql`select c.id from shop_conversations c
           left join conversation_reads r on r.conversation_id = c.id and r.user_id = ${userId}
           where c.shop_id = ${shopId} and c.id in ${ids}
             and exists (select 1 from shop_messages m where m.conversation_id = c.id and m.direction = 'incoming' and m.seq > coalesce(r.last_seen_seq, 0))`,
      );
      for (const r of rows) out.add(r.id);
    }
    return out;
  }

  /** P10: how many conversations of the shop are unread for this member (the inbox nav count). */
  async unreadCount(shopId: string, userId: string): Promise<number> {
    return queryRow<{ n: number }>(
      this.db,
      sql`select count(*) n from shop_conversations c
           left join conversation_reads r on r.conversation_id = c.id and r.user_id = ${userId}
           where c.shop_id = ${shopId}
             and exists (select 1 from shop_messages m where m.conversation_id = c.id and m.direction = 'incoming' and m.seq > coalesce(r.last_seen_seq, 0))`,
    )!.n;
  }

  /**
   * P10: the member has seen the conversation up to `seq` (default: its newest message). The marker only moves forward
   * and never past the newest message. Returns the stored marker.
   */
  async markRead(shopId: string, conversationId: string, userId: string, seq?: number): Promise<number> {
    return this.handle.transaction(() => {
      if (!this.getConversationTx(shopId, conversationId)) throw new ConversationNotFoundError('conversation');
      const max = this.db
        .select({ n: sql<number>`coalesce(max(${t.shopMessages.seq}), 0)` })
        .from(t.shopMessages)
        .where(and(eq(t.shopMessages.shopId, shopId), eq(t.shopMessages.conversationId, conversationId)))
        .get()!.n;
      const target = Math.min(seq === undefined ? max : Math.max(Math.trunc(seq), 0), max);
      const cur = this.db
        .select()
        .from(t.conversationReads)
        .where(and(eq(t.conversationReads.conversationId, conversationId), eq(t.conversationReads.userId, userId)))
        .get();
      if (cur && cur.lastSeenSeq >= target) return cur.lastSeenSeq;
      this.db
        .insert(t.conversationReads)
        .values({ shopId, conversationId, userId, lastSeenSeq: target, updatedAt: this.now() })
        .onConflictDoUpdate({ target: [t.conversationReads.conversationId, t.conversationReads.userId], set: { lastSeenSeq: target, updatedAt: this.now() } })
        .run();
      return target;
    });
  }

  /** P10: replaces the shop's private note about a customer (empty text clears it). */
  async setCustomerNote(shopId: string, customerId: string, note: string, userId: string): Promise<CustomerRow> {
    const v = note.trim();
    if (v.length > NOTE_MAX) throw new ConversationValidationError([`note: at most ${NOTE_MAX} characters`]);
    const r = this.db
      .update(t.customers)
      .set({ note: v || null, noteUpdatedAt: this.now(), noteUpdatedByUserId: userId })
      .where(and(eq(t.customers.shopId, shopId), eq(t.customers.id, customerId)))
      .returning()
      .get();
    if (!r) throw new ConversationNotFoundError('customer');
    return r;
  }

  /** P10: contact data and order history of one customer across all of their conversations in this shop. */
  async customerProfile(shopId: string, customerId: string): Promise<CustomerProfile> {
    const contact = this.db
      .select({ phone: sql<string | null>`coalesce(${t.orderDrafts.recipientPhone}, ${t.orderDrafts.contactPhone})`, city: t.orderDrafts.npCityName })
      .from(t.orderDrafts)
      .where(
        and(
          eq(t.orderDrafts.shopId, shopId),
          eq(t.orderDrafts.customerId, customerId),
          sql`(${t.orderDrafts.recipientPhone} is not null or ${t.orderDrafts.contactPhone} is not null or ${t.orderDrafts.npCityName} is not null)`,
        ),
      )
      .orderBy(desc(t.orderDrafts.createdAt), desc(t.orderDrafts.id))
      .all();
    const placed = sql`${t.orderDrafts.status} not in (${sql.join(
      NOT_PLACED.map((x) => sql`${x}`),
      sql`, `,
    )})`;
    const totals = this.db
      .select({ currency: t.orderDrafts.currency, n: sql<number>`count(*)`, total: sql<number>`sum(${t.orderDrafts.totalMinor})` })
      .from(t.orderDrafts)
      .where(and(eq(t.orderDrafts.shopId, shopId), eq(t.orderDrafts.customerId, customerId), placed))
      .groupBy(t.orderDrafts.currency)
      .orderBy(asc(t.orderDrafts.currency))
      .all();
    const all = this.db
      .select({ n: sql<number>`count(*)`, last: sql<string | null>`max(${t.orderDrafts.createdAt})` })
      .from(t.orderDrafts)
      .where(and(eq(t.orderDrafts.shopId, shopId), eq(t.orderDrafts.customerId, customerId)))
      .get()!;
    return {
      phone: contact.find((c) => c.phone)?.phone ?? null,
      city: contact.find((c) => c.city)?.city ?? null,
      orders: { count: all.n, placed: totals.reduce((a, r) => a + r.n, 0), totals: totals.map((r) => ({ currency: r.currency, totalMinor: r.total })), lastAt: all.last },
    };
  }
}
