import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import * as t from './schema';

export type CustomerRow = typeof t.customers.$inferSelect;
export type ShopConversationRow = typeof t.shopConversations.$inferSelect;
export type ShopMessageRow = typeof t.shopMessages.$inferSelect;
export type ConversationWithCustomer = { conversation: ShopConversationRow; customer: CustomerRow };
export type DeliveryStatus = ShopMessageRow['deliveryStatus'];

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
  .array(z.strictObject({ kind: z.string().trim().min(1).max(40), url: z.string().max(2048).optional(), name: z.string().max(200).optional() }))
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
const isUnique = (e: unknown) => (e as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE';
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
  ensureConversation(shopId: string, input: { channel: string; conversationExternalId: string; customer: z.input<typeof customerInput> }): ConversationWithCustomer {
    const v = parse(z.strictObject({ channel, conversationExternalId: externalId, customer: customerInput }), input);
    return this.handle.raw.transaction(() => {
      const customer = this.upsertCustomer(shopId, v.channel, v.customer);
      const conv = this.conversationFor(shopId, v.channel, v.conversationExternalId, customer);
      return { conversation: conv, customer };
    })();
  }

  /** Upserts the customer and conversation, then stores the inbound message once. A new inbound message reopens a closed conversation. */
  ingestMessage(shopId: string, input: IngestMessageInput): { message: ShopMessageRow; conversation: ShopConversationRow; customer: CustomerRow; duplicated: boolean } {
    const v = parse(ingestInput, input);
    return this.handle.raw.transaction(() => {
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
      return { message, duplicated, customer, conversation: this.getConversation(shopId, conv.id)!.conversation };
    })();
  }

  /** Records an outgoing message: `pending` (to be sent), `sent` (already on the channel, needs its channel id) or `uncertain` (send attempted, outcome unknown). */
  recordOutbound(shopId: string, conversationId: string, input: RecordOutboundInput): { message: ShopMessageRow; duplicated: boolean } {
    const v = parse(outboundInput, input);
    return this.handle.raw.transaction(() => {
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
    })();
  }

  /** pending -> sent | failed | uncertain; uncertain -> sent | failed. `sent` needs a channel id (given now or already stored). */
  setDeliveryStatus(shopId: string, messageId: string, status: DeliveryStatus, extra: z.input<typeof deliveryUpdate> = {}): ShopMessageRow {
    const x = parse(deliveryUpdate, extra);
    return this.handle.raw.transaction(() => {
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
        if (isUnique(e)) throw new ConversationConflictError('channel message id already stored in this conversation');
        throw e;
      }
    })();
  }

  setConversationStatus(shopId: string, conversationId: string, status: ShopConversationRow['status']): ShopConversationRow {
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

  getCustomer(shopId: string, customerId: string): CustomerRow | undefined {
    return this.db
      .select()
      .from(t.customers)
      .where(and(eq(t.customers.shopId, shopId), eq(t.customers.id, customerId)))
      .get();
  }

  listCustomers(shopId: string, f: { limit?: number; offset?: number } = {}): { items: CustomerRow[]; total: number } {
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

  getConversation(shopId: string, conversationId: string): ConversationWithCustomer | undefined {
    const r = this.db
      .select({ conversation: t.shopConversations, customer: t.customers })
      .from(t.shopConversations)
      .innerJoin(t.customers, eq(t.customers.id, t.shopConversations.customerId))
      .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.id, conversationId)))
      .get();
    return r;
  }

  /** Most recently active first. */
  listConversations(
    shopId: string,
    f: { status?: ShopConversationRow['status']; customerId?: string; limit?: number; offset?: number } = {},
  ): { items: ConversationWithCustomer[]; total: number } {
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
  listMessages(shopId: string, conversationId: string, f: { limit?: number; beforeSeq?: number } = {}): { items: ShopMessageRow[]; hasMore: boolean } {
    if (!this.getConversation(shopId, conversationId)) throw new ConversationNotFoundError('conversation');
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

  findConversationByExternal(shopId: string, ch: string, extId: string): ConversationWithCustomer | undefined {
    return this.db
      .select({ conversation: t.shopConversations, customer: t.customers })
      .from(t.shopConversations)
      .innerJoin(t.customers, eq(t.customers.id, t.shopConversations.customerId))
      .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.channel, ch), eq(t.shopConversations.externalId, extId)))
      .get();
  }

  findMessageByExternal(shopId: string, conversationId: string, extId: string): ShopMessageRow | undefined {
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
  adoptPendingOutbound(
    shopId: string,
    conversationId: string,
    text: string,
    extId: string,
    status: 'sent' | 'uncertain',
    senderType: 'ai' | 'human' = 'ai',
  ): ShopMessageRow | undefined {
    return this.handle.raw.transaction(() => {
      if (this.findMessageByExternal(shopId, conversationId, extId)) return undefined;
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
      return pending && this.setDeliveryStatus(shopId, pending.id, status, { externalId: extId });
    })();
  }

  /** Human takeover switch (Feature 8). Idempotent: pausing a paused conversation keeps the first pauser and time. */
  setAiPaused(shopId: string, conversationId: string, paused: boolean, userId: string | null): ConversationWithCustomer {
    return this.handle.raw.transaction(() => {
      const cur = this.getConversation(shopId, conversationId);
      if (!cur) throw new ConversationNotFoundError('conversation');
      if (cur.conversation.aiPaused === paused) return cur;
      this.db
        .update(t.shopConversations)
        .set(paused ? { aiPaused: true, aiPausedAt: this.now(), aiPausedByUserId: userId } : { aiPaused: false, aiPausedAt: null, aiPausedByUserId: null })
        .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.id, conversationId)))
        .run();
      return this.getConversation(shopId, conversationId)!;
    })();
  }

  /** When the customer last wrote in this conversation (channel time), or undefined: the start of Instagram's 24-hour window. */
  lastInboundAt(shopId: string, conversationId: string): string | undefined {
    return this.db
      .select({ at: sql<string>`max(${t.shopMessages.occurredAt})` })
      .from(t.shopMessages)
      .where(and(eq(t.shopMessages.shopId, shopId), eq(t.shopMessages.conversationId, conversationId), eq(t.shopMessages.direction, 'incoming')))
      .get()?.at ?? undefined;
  }

  getMessage(shopId: string, messageId: string): ShopMessageRow | undefined {
    return this.db
      .select()
      .from(t.shopMessages)
      .where(and(eq(t.shopMessages.shopId, shopId), eq(t.shopMessages.id, messageId)))
      .get();
  }
}
