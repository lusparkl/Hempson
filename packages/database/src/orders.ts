import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import { DeliveryRepository, normalizeUaPhone } from './delivery';
import { CustomerNoticeRepository, type CustomerNoticeEvent } from './notices';
import { PAYMENT_METHODS } from './order-kinds';
import * as t from './schema';

export { ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATES, PAYMENT_PROVIDERS } from './order-kinds';
export type OrderDraftRow = typeof t.orderDrafts.$inferSelect;
export type OrderDraftItemRow = typeof t.orderDraftItems.$inferSelect;
export type OrderEventRow = typeof t.orderEvents.$inferSelect;
export type OrderStatus = OrderDraftRow['status'];
/** Who changed an order: `user:<id>`, `ai`, `system:auto_confirm`, `system:supersede`, `system:timeout`, `provider:nova_poshta`, `provider:monobank`. */
export type OrderActor = string;
export type OrderDraft = { draft: OrderDraftRow; items: OrderDraftItemRow[] };
export type OrderLine = { productId: string; variantId: string; sku: string; productName: string; options: Record<string, string>; quantity: number; unitPriceMinor: number; lineTotalMinor: number; stock: number };
export type OrderQuote = { currency: string; totalMinor: number; lines: OrderLine[] };

export class OrderValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid order: ${issues.join('; ')}`);
    this.name = 'OrderValidationError';
  }
}
export class OrderNotFoundError extends Error {
  constructor() {
    super('order draft not found');
    this.name = 'OrderNotFoundError';
  }
}
/** The draft is not in a state that allows the change (e.g. already decided). */
export class OrderStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderStateError';
  }
}
export class OrderStockError extends Error {
  constructor(readonly sku: string) {
    super(`not enough stock to approve: ${sku}`);
    this.name = 'OrderStockError';
  }
}

const text = (max: number) => z.string().trim().max(max).transform((s) => s || undefined).optional();
const npRef = z.string().trim().min(1).max(64);
/** Checkout data (P4). The NP refs and names must come from Nova Poshta lookups; callers never type them. */
const checkoutInput = z.strictObject({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(5).max(40),
  npCityRef: npRef,
  npCityName: z.string().trim().min(1).max(200),
  npWarehouseRef: npRef,
  npWarehouseName: z.string().trim().min(1).max(300),
  paymentMethod: z.enum(PAYMENT_METHODS),
});
const lineInput = z.strictObject({ sku: z.string().trim().min(1).max(64), quantity: z.number().int().min(1).max(1000) });
const quoteInput = z.array(lineInput).min(1).max(50);
const createInput = z.strictObject({
  conversationId: z.uuid(),
  createdBy: z.enum(['ai', 'user']),
  runId: z.uuid().optional(),
  contactName: text(200),
  contactPhone: text(40),
  deliveryInfo: text(500),
  note: text(1000),
  checkout: checkoutInput.optional(),
  items: quoteInput,
});
const decisionNote = z.string().trim().max(500).optional();

export type CreateOrderDraftInput = z.input<typeof createInput>;
export type CheckoutInput = z.input<typeof checkoutInput>;

/** States that hold stock taken at approval; cancelling from one of them restores it (D25). */
const STOCK_HELD: OrderStatus[] = ['approved', 'awaiting_payment', 'cod_confirmed', 'paid'];
/** D25: a member may record `refund_requested` from these (refunds themselves happen in the provider's cabinet, D24). */
const REFUNDABLE: OrderStatus[] = ['paid', 'shipped', 'delivered', 'returning', 'returned'];
/** P6: the customer notice queued with a move into this status (prepaid approval is announced by the payment link). */
const NOTICE_ON: Partial<Record<OrderStatus, CustomerNoticeEvent>> = { cod_confirmed: 'confirmed', rejected: 'rejected', paid: 'paid', shipped: 'shipped', delivered: 'delivered' };

/** What is still missing before a draft may be approved. */
export function checkoutMissing(d: OrderDraftRow): string[] {
  const miss: string[] = [];
  if (!d.recipientFirstName || !d.recipientLastName) miss.push('recipient name');
  if (!d.recipientPhone) miss.push('phone');
  if (!d.npCityRef) miss.push('Nova Poshta city');
  if (!d.npWarehouseRef) miss.push('Nova Poshta branch');
  if (!d.paymentMethod) miss.push('payment method');
  return miss;
}
export type QuoteItemsInput = z.input<typeof quoteInput>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new OrderValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
  return r.data;
}

/**
 * Shop-scoped orders (Feature 7, lifecycle D25). Prices and totals come only from the catalog at draft time; a caller
 * (including the AI) supplies SKUs and quantities, never prices. Drafts start `pending_approval`; approval (a member, or
 * the server in `auto_confirm`, D26) takes stock and moves the order to `cod_confirmed` or `awaiting_payment`. Every
 * transition writes an `order_events` row. Every method takes `shopId` first and filters by it. Internal: no authorization here.
 */
export class OrderRepository {
  readonly db: Db;
  private readonly delivery: DeliveryRepository;
  private readonly notices: CustomerNoticeRepository;
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
    this.delivery = new DeliveryRepository(handle, clock);
    this.notices = new CustomerNoticeRepository(handle, clock);
  }
  private now() {
    return this.clock().toISOString();
  }

  /** Prices the given SKUs from the live catalog. Throws with every problem found; never partial. */
  quote(shopId: string, input: QuoteItemsInput): OrderQuote {
    const items = parse(quoteInput, input);
    const wanted = new Map<string, number>();
    for (const i of items) {
      const sku = i.sku.toUpperCase();
      wanted.set(sku, (wanted.get(sku) ?? 0) + i.quantity);
    }
    const rows = this.db
      .select({ v: t.productVariants, p: t.products })
      .from(t.productVariants)
      .innerJoin(t.products, eq(t.products.id, t.productVariants.productId))
      .where(and(eq(t.productVariants.shopId, shopId), inArray(t.productVariants.sku, [...wanted.keys()])))
      .all();
    const bySku = new Map(rows.map((r) => [r.v.sku, r]));
    const issues: string[] = [];
    const lines: OrderLine[] = [];
    for (const [sku, quantity] of wanted) {
      const r = bySku.get(sku);
      if (!r || !r.p.active || !r.v.active) {
        issues.push(`${sku}: not available in the catalog`);
        continue;
      }
      if (quantity > r.v.stock) {
        issues.push(`${sku}: requested ${quantity}, only ${r.v.stock} in stock`);
        continue;
      }
      const unitPriceMinor = r.v.priceMinor ?? r.p.priceMinor;
      lines.push({
        productId: r.p.id,
        variantId: r.v.id,
        sku,
        productName: r.p.name,
        options: r.v.options,
        quantity,
        unitPriceMinor,
        lineTotalMinor: unitPriceMinor * quantity,
        stock: r.v.stock,
      });
    }
    const currencies = new Set(lines.map((l) => bySku.get(l.sku)!.p.currency));
    if (currencies.size > 1) issues.push('items use different currencies; split them into separate orders');
    if (issues.length) throw new OrderValidationError(issues);
    return { currency: [...currencies][0]!, totalMinor: lines.reduce((s, l) => s + l.lineTotalMinor, 0), lines };
  }

  /**
   * Creates a `pending_approval` draft for a conversation of this shop. A newer draft from the AI replaces a still-pending
   * earlier draft of the same conversation (the old one becomes `cancelled`), so the seller never sees stale duplicates.
   */
  createDraft(shopId: string, input: CreateOrderDraftInput): OrderDraft {
    const v = parse(createInput, input);
    return this.handle.raw.transaction(() => {
      const conv = this.db
        .select()
        .from(t.shopConversations)
        .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.id, v.conversationId)))
        .get();
      if (!conv) throw new OrderValidationError(['conversationId: not found']);
      if (v.runId && !this.db.select({ id: t.aiRuns.id }).from(t.aiRuns).where(and(eq(t.aiRuns.shopId, shopId), eq(t.aiRuns.id, v.runId))).get())
        throw new OrderValidationError(['runId: not found']);
      const q = this.quote(shopId, v.items);
      const co = v.checkout && this.checkCheckout(shopId, conv.customerId, v.checkout);
      const ts = this.now();
      if (v.createdBy === 'ai') {
        const stale = this.db
          .update(t.orderDrafts)
          .set({ status: 'cancelled', decidedAt: ts, decisionNote: 'superseded by a newer draft', updatedAt: ts })
          .where(and(eq(t.orderDrafts.shopId, shopId), eq(t.orderDrafts.conversationId, conv.id), eq(t.orderDrafts.status, 'pending_approval'), eq(t.orderDrafts.createdBy, 'ai')))
          .returning({ id: t.orderDrafts.id })
          .all();
        for (const r of stale) this.event(shopId, r.id, 'pending_approval', 'cancelled', 'system:supersede', 'superseded by a newer draft');
      }
      const draft: OrderDraftRow = {
        id: randomUUID(),
        shopId,
        conversationId: conv.id,
        customerId: conv.customerId,
        status: 'pending_approval',
        createdBy: v.createdBy,
        runId: v.runId ?? null,
        contactName: v.contactName ?? (co ? `${co.firstName} ${co.lastName}` : null),
        contactPhone: v.contactPhone ?? co?.phone ?? null,
        deliveryInfo: v.deliveryInfo ?? (co ? `${co.npCityName}, ${co.npWarehouseName}` : null),
        note: v.note ?? null,
        currency: q.currency,
        totalMinor: q.totalMinor,
        decidedByUserId: null,
        decidedAt: null,
        decisionNote: null,
        approvedAt: null,
        recipientFirstName: co?.firstName ?? null,
        recipientLastName: co?.lastName ?? null,
        recipientPhone: co?.phone ?? null,
        npCityRef: co?.npCityRef ?? null,
        npCityName: co?.npCityName ?? null,
        npWarehouseRef: co?.npWarehouseRef ?? null,
        npWarehouseName: co?.npWarehouseName ?? null,
        paymentMethod: co?.paymentMethod ?? null,
        ttnState: null,
        ttnError: null,
        ttn: null,
        npDocumentRef: null,
        npStatusCode: null,
        npStatusText: null,
        npStatusAt: null,
        paymentDueAt: null,
        paymentReminderAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
      this.db.insert(t.orderDrafts).values(draft).run();
      this.event(shopId, draft.id, null, 'pending_approval', v.createdBy === 'ai' ? 'ai' : 'user', null);
      const items: OrderDraftItemRow[] = q.lines.map((l) => ({
        id: randomUUID(),
        shopId,
        draftId: draft.id,
        productId: l.productId,
        variantId: l.variantId,
        sku: l.sku,
        productName: l.productName,
        options: l.options,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
      }));
      this.db.insert(t.orderDraftItems).values(items).run();
      return { draft, items };
    })();
  }

  getDraft(shopId: string, draftId: string): OrderDraft | undefined {
    const draft = this.db
      .select()
      .from(t.orderDrafts)
      .where(and(eq(t.orderDrafts.shopId, shopId), eq(t.orderDrafts.id, draftId)))
      .get();
    return draft && { draft, items: this.itemsOf(shopId, [draft.id]) };
  }

  private itemsOf(shopId: string, ids: string[]): OrderDraftItemRow[] {
    if (!ids.length) return [];
    return this.db
      .select()
      .from(t.orderDraftItems)
      .where(and(eq(t.orderDraftItems.shopId, shopId), inArray(t.orderDraftItems.draftId, ids)))
      .orderBy(asc(t.orderDraftItems.sku))
      .all();
  }

  /** Newest first. */
  listDrafts(shopId: string, f: { status?: OrderDraftRow['status']; conversationId?: string; limit?: number; offset?: number } = {}): { items: OrderDraft[]; total: number } {
    const conds = [eq(t.orderDrafts.shopId, shopId)];
    if (f.status) conds.push(eq(t.orderDrafts.status, f.status));
    if (f.conversationId) conds.push(eq(t.orderDrafts.conversationId, f.conversationId));
    const where = and(...conds);
    const total = this.db.select({ n: sql<number>`count(*)` }).from(t.orderDrafts).where(where).get()!.n;
    const rows = this.db
      .select()
      .from(t.orderDrafts)
      .where(where)
      .orderBy(desc(t.orderDrafts.createdAt), desc(t.orderDrafts.id))
      .limit(Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 200))
      .offset(Math.max(Math.trunc(f.offset ?? 0), 0))
      .all();
    const items = this.itemsOf(shopId, rows.map((r) => r.id));
    return { total, items: rows.map((draft) => ({ draft, items: items.filter((i) => i.draftId === draft.id) })) };
  }

  /**
   * Orders created in [from, to), oldest first, with items and the time of their `paid` event (P8 Excel export). At most
   * `limit` rows; the caller says when the list was cut.
   */
  listForExport(shopId: string, f: { from: string; to: string; status?: OrderStatus; limit: number }): Array<OrderDraft & { paidAt: string | null }> {
    const conds = [eq(t.orderDrafts.shopId, shopId), sql`${t.orderDrafts.createdAt} >= ${f.from}`, sql`${t.orderDrafts.createdAt} < ${f.to}`];
    if (f.status) conds.push(eq(t.orderDrafts.status, f.status));
    const rows = this.db
      .select()
      .from(t.orderDrafts)
      .where(and(...conds))
      .orderBy(asc(t.orderDrafts.createdAt), asc(t.orderDrafts.id))
      .limit(f.limit)
      .all();
    const ids = rows.map((r) => r.id);
    const items = new Map<string, OrderDraftItemRow[]>();
    for (const it of this.itemsOf(shopId, ids)) items.set(it.draftId, [...(items.get(it.draftId) ?? []), it]);
    const paid = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 500) {
      const ev = this.db
        .select({ draftId: t.orderEvents.draftId, at: sql<string>`min(${t.orderEvents.createdAt})` })
        .from(t.orderEvents)
        .where(and(eq(t.orderEvents.shopId, shopId), eq(t.orderEvents.toStatus, 'paid'), inArray(t.orderEvents.draftId, ids.slice(i, i + 500))))
        .groupBy(t.orderEvents.draftId)
        .all();
      for (const e of ev) paid.set(e.draftId, e.at);
    }
    return rows.map((draft) => ({ draft, items: items.get(draft.id) ?? [], paidAt: paid.get(draft.id) ?? null }));
  }

  /** Validates checkout data against the shop's rules (phone form, payment methods, COD refusal limit). */
  private checkCheckout(shopId: string, customerId: string, c: z.output<typeof checkoutInput>): z.output<typeof checkoutInput> {
    const phone = normalizeUaPhone(c.phone);
    if (!phone) throw new OrderValidationError(['checkout.phone: not a Ukrainian phone number']);
    const pm = this.delivery.paymentMethods(shopId, { phone, customerId });
    if (!pm.methods.includes(c.paymentMethod))
      throw new OrderValidationError([
        c.paymentMethod === 'cod' && pm.codBlocked ? 'checkout.paymentMethod: cash on delivery is not available for this customer' : `checkout.paymentMethod: ${c.paymentMethod} is not offered by this shop`,
      ]);
    return { ...c, phone };
  }

  /** Writes one audit row (D25). Callers run inside the transition's transaction. */
  private event(shopId: string, draftId: string, from: OrderStatus | null, to: OrderStatus, actor: OrderActor, note: string | null): void {
    this.db.insert(t.orderEvents).values({ id: randomUUID(), shopId, draftId, fromStatus: from, toStatus: to, actor, note, createdAt: this.now() }).run();
  }

  listEvents(shopId: string, draftId: string): OrderEventRow[] {
    return this.db
      .select()
      .from(t.orderEvents)
      .where(and(eq(t.orderEvents.shopId, shopId), eq(t.orderEvents.draftId, draftId)))
      .orderBy(asc(t.orderEvents.createdAt), sql`rowid`)
      .all();
  }

  /**
   * Moves the order only if it is still in `from` (compare-and-set). Returns false when another writer got there first.
   * A move that the customer hears about queues its notice in the same transaction (P6).
   */
  private move(shopId: string, draftId: string, from: OrderStatus, to: OrderStatus, actor: OrderActor, note: string | null, set: Partial<OrderDraftRow> = {}): boolean {
    const r = this.db
      .update(t.orderDrafts)
      .set({ ...set, status: to, updatedAt: this.now() })
      .where(and(eq(t.orderDrafts.shopId, shopId), eq(t.orderDrafts.id, draftId), eq(t.orderDrafts.status, from)))
      .run();
    if (!r.changes) return false;
    this.event(shopId, draftId, from, to, actor, note);
    const notice = NOTICE_ON[to];
    if (notice) this.notices.enqueue(shopId, draftId, notice);
    return true;
  }

  private restock(shopId: string, draftId: string): void {
    const ts = this.now();
    for (const it of this.itemsOf(shopId, [draftId]))
      this.db
        .update(t.productVariants)
        .set({ stock: sql`${t.productVariants.stock} + ${it.quantity}`, updatedAt: ts })
        .where(and(eq(t.productVariants.shopId, shopId), eq(t.productVariants.id, it.variantId)))
        .run();
  }

  /**
   * Approval: all-or-nothing. Requires complete checkout data. Stock is checked and reduced atomically (conditional
   * UPDATE per line); if any line cannot be covered the whole approval fails and nothing changes. The order then moves
   * on to `cod_confirmed` or `awaiting_payment` by its payment method. Approving an already decided draft is refused.
   */
  approve(shopId: string, draftId: string, userId: string, note?: string): OrderDraft {
    const n = parse(decisionNote, note);
    return this.handle.raw.transaction(() => this.approveTx(shopId, this.requirePending(shopId, draftId), `user:${userId}`, userId, n))();
  }

  private approveTx(shopId: string, cur: OrderDraftRow, actor: OrderActor, userId: string | null, note: string | undefined): OrderDraft {
    const missing = checkoutMissing(cur);
    if (missing.length) throw new OrderValidationError([`checkout data incomplete: ${missing.join(', ')}`]);
    const ts = this.now();
    for (const it of this.itemsOf(shopId, [cur.id])) {
      const ok = this.db
        .update(t.productVariants)
        .set({ stock: sql`${t.productVariants.stock} - ${it.quantity}`, updatedAt: ts })
        .where(and(eq(t.productVariants.shopId, shopId), eq(t.productVariants.id, it.variantId), eq(t.productVariants.active, true), sql`${t.productVariants.stock} >= ${it.quantity}`))
        .run();
      if (!ok.changes) throw new OrderStockError(it.sku);
    }
    this.move(shopId, cur.id, 'pending_approval', 'approved', actor, note || null, { decidedByUserId: userId, decidedAt: ts, decisionNote: note || null, approvedAt: ts });
    if (cur.paymentMethod === 'cod') this.move(shopId, cur.id, 'approved', 'cod_confirmed', actor, null);
    else this.move(shopId, cur.id, 'approved', 'awaiting_payment', actor, null, { paymentDueAt: new Date(this.clock().getTime() + this.paymentTimeoutHours(shopId) * 3600_000).toISOString() });
    return this.getDraft(shopId, cur.id)!;
  }

  /** D25: hours an `awaiting_payment` order waits before it is cancelled (shop setting, default 24). */
  private paymentTimeoutHours(shopId: string): number {
    return this.db.select({ h: t.shopPaymentSettings.paymentTimeoutHours }).from(t.shopPaymentSettings).where(eq(t.shopPaymentSettings.shopId, shopId)).get()?.h ?? 24;
  }

  /**
   * D26 `auto_confirm`: the server approves only when every check passes now; anything else leaves the draft
   * `pending_approval` for a person and says why (a short code). COD for a customer at the refusal limit is never confirmed.
   */
  autoConfirm(shopId: string, draftId: string, opts: { maxTotalMinor: number | null }): { approved: true; draft: OrderDraft } | { approved: false; reason: string } {
    try {
      return this.handle.raw.transaction(() => {
        const cur = this.requirePending(shopId, draftId);
        if (checkoutMissing(cur).length) return { approved: false as const, reason: 'CHECKOUT_INCOMPLETE' };
        const pm = this.delivery.paymentMethods(shopId, { phone: cur.recipientPhone, customerId: cur.customerId });
        if (!pm.methods.includes(cur.paymentMethod!)) return { approved: false as const, reason: pm.codBlocked && cur.paymentMethod === 'cod' ? 'COD_REFUSAL_LIMIT' : 'PAYMENT_METHOD_UNAVAILABLE' };
        if (opts.maxTotalMinor !== null && cur.totalMinor > opts.maxTotalMinor) return { approved: false as const, reason: 'OVER_CAP' };
        const conv = this.db
          .select({ paused: t.shopConversations.aiPaused })
          .from(t.shopConversations)
          .where(and(eq(t.shopConversations.shopId, shopId), eq(t.shopConversations.id, cur.conversationId)))
          .get();
        if (!conv || conv.paused) return { approved: false as const, reason: 'AI_PAUSED' };
        const esc = this.db
          .select({ id: t.escalations.id })
          .from(t.escalations)
          .where(and(eq(t.escalations.shopId, shopId), eq(t.escalations.conversationId, cur.conversationId), eq(t.escalations.status, 'open')))
          .get();
        if (esc) return { approved: false as const, reason: 'ESCALATION_OPEN' };
        // The total must still be what the catalog says now (prices may have changed since the draft).
        const items = this.itemsOf(shopId, [cur.id]);
        let q: OrderQuote;
        try {
          q = this.quote(shopId, items.map((i) => ({ sku: i.sku, quantity: i.quantity })));
        } catch {
          return { approved: false as const, reason: 'STOCK' };
        }
        if (q.totalMinor !== cur.totalMinor || q.currency !== cur.currency) return { approved: false as const, reason: 'PRICE_CHANGED' };
        return { approved: true as const, draft: this.approveTx(shopId, cur, 'system:auto_confirm', null, undefined) };
      })();
    } catch (e) {
      if (e instanceof OrderStockError) return { approved: false, reason: 'STOCK' };
      if (e instanceof OrderStateError || e instanceof OrderNotFoundError) return { approved: false, reason: 'NOT_PENDING' };
      throw e;
    }
  }

  reject(shopId: string, draftId: string, userId: string, note?: string): OrderDraft {
    const n = parse(decisionNote, note);
    return this.handle.raw.transaction(() => {
      const cur = this.requirePending(shopId, draftId);
      this.move(shopId, cur.id, 'pending_approval', 'rejected', `user:${userId}`, n || null, { decidedByUserId: userId, decidedAt: this.now(), decisionNote: n || null });
      return this.getDraft(shopId, cur.id)!;
    })();
  }

  /**
   * A member cancels an approved order before it ships (D25): stock comes back once, in the same transaction. Refused
   * while a TTN exists or may exist (`creating`, `uncertain`).
   */
  cancel(shopId: string, draftId: string, userId: string, note?: string): OrderDraft {
    const n = parse(decisionNote, note);
    return this.handle.raw.transaction(() => {
      const cur = this.getDraft(shopId, draftId)?.draft;
      if (!cur) throw new OrderNotFoundError();
      if (!STOCK_HELD.includes(cur.status)) throw new OrderStateError(`an order in status ${cur.status} cannot be cancelled`);
      if (cur.ttnState === 'creating' || cur.ttnState === 'uncertain' || cur.ttnState === 'created') throw new OrderStateError('a Nova Poshta parcel may exist for this order; resolve the TTN first');
      if (!this.move(shopId, cur.id, cur.status, 'cancelled', `user:${userId}`, n || null, { decisionNote: n || cur.decisionNote })) throw new OrderStateError('the order changed meanwhile, reload it');
      this.restock(shopId, cur.id);
      return this.getDraft(shopId, cur.id)!;
    })();
  }

  // ---------- payments (P5, D24) ----------

  /** A verified provider event says the order is paid: `awaiting_payment` to `paid`, once. False if the order is elsewhere. */
  markPaid(shopId: string, draftId: string, actor: OrderActor, note: string): boolean {
    return this.handle.raw.transaction(() => this.move(shopId, draftId, 'awaiting_payment', 'paid', actor, note))();
  }

  /** The payment deadline passed without a payment: cancelled with restock, attributed to `system:timeout`. */
  expireUnpaid(shopId: string, draftId: string): boolean {
    return this.handle.raw.transaction(() => {
      if (!this.move(shopId, draftId, 'awaiting_payment', 'cancelled', 'system:timeout', 'payment not received in time', { decisionNote: 'payment not received in time' })) return false;
      this.restock(shopId, draftId);
      return true;
    })();
  }

  /** Claims the one payment reminder of an unpaid order (compare-and-set): true for exactly one caller. */
  claimPaymentReminder(shopId: string, draftId: string): boolean {
    const r = this.db
      .update(t.orderDrafts)
      .set({ paymentReminderAt: this.now(), updatedAt: this.now() })
      .where(and(eq(t.orderDrafts.shopId, shopId), eq(t.orderDrafts.id, draftId), eq(t.orderDrafts.status, 'awaiting_payment'), isNull(t.orderDrafts.paymentReminderAt)))
      .run();
    return r.changes > 0;
  }

  /** Unpaid prepaid orders across shops, earliest deadline first (the payment job checks deadlines and reminders). */
  listAwaitingPayment(limit = 500): OrderDraftRow[] {
    return this.db
      .select()
      .from(t.orderDrafts)
      .where(and(eq(t.orderDrafts.status, 'awaiting_payment'), sql`${t.orderDrafts.paymentDueAt} is not null`))
      .orderBy(asc(t.orderDrafts.paymentDueAt))
      .limit(limit)
      .all();
  }

  /** A member records that the customer asked for a refund (D24: the refund itself is made in the provider's cabinet). */
  requestRefund(shopId: string, draftId: string, userId: string, note?: string): OrderDraft {
    const n = parse(decisionNote, note);
    return this.handle.raw.transaction(() => {
      const cur = this.getDraft(shopId, draftId)?.draft;
      if (!cur) throw new OrderNotFoundError();
      if (!REFUNDABLE.includes(cur.status) || !this.move(shopId, draftId, cur.status, 'refund_requested', `user:${userId}`, n || null)) throw new OrderStateError(`a refund cannot be requested for an order in status ${cur.status}`);
      return this.getDraft(shopId, draftId)!;
    })();
  }

  // ---------- Nova Poshta TTN and tracking (P4) ----------

  /**
   * Claims the right to create the TTN: only a `cod_confirmed` order (prepaid ones only from `paid`, D25) without a TTN
   * and not already claimed. The claim is a compare-and-set, so two callers can never both create a parcel.
   */
  claimTtn(shopId: string, draftId: string): OrderDraft {
    const r = this.db
      .update(t.orderDrafts)
      .set({ ttnState: 'creating', ttnError: null, updatedAt: this.now() })
      .where(
        and(
          eq(t.orderDrafts.shopId, shopId),
          eq(t.orderDrafts.id, draftId),
          or(and(eq(t.orderDrafts.status, 'cod_confirmed'), eq(t.orderDrafts.paymentMethod, 'cod')), and(eq(t.orderDrafts.status, 'paid'), eq(t.orderDrafts.paymentMethod, 'prepaid'))),
          or(isNull(t.orderDrafts.ttnState), eq(t.orderDrafts.ttnState, 'failed')),
        ),
      )
      .run();
    if (!r.changes) {
      const cur = this.getDraft(shopId, draftId);
      if (!cur) throw new OrderNotFoundError();
      throw new OrderStateError(cur.draft.ttnState === 'creating' ? 'the TTN is being created' : cur.draft.ttn ? 'this order already has a TTN' : `no TTN can be created for an order in status ${cur.draft.status}${cur.draft.ttnState === 'uncertain' ? ' (previous attempt uncertain)' : ''}`);
    }
    return this.getDraft(shopId, draftId)!;
  }

  /** The TTN Nova Poshta returned: the order is `shipped`. */
  completeTtn(shopId: string, draftId: string, doc: { ttn: string; documentRef: string }): OrderDraft {
    return this.handle.raw.transaction(() => {
      const cur = this.getDraft(shopId, draftId)?.draft;
      if (!cur || cur.ttnState !== 'creating') throw new OrderStateError('no TTN creation in progress');
      this.move(shopId, draftId, cur.status, 'shipped', 'provider:nova_poshta', `TTN ${doc.ttn}`, { ttnState: 'created', ttn: doc.ttn, npDocumentRef: doc.documentRef, ttnError: null });
      return this.getDraft(shopId, draftId)!;
    })();
  }

  /** `failed`: Nova Poshta refused, a member may retry. `uncertain`: a parcel may exist, never retried automatically. */
  failTtn(shopId: string, draftId: string, state: 'failed' | 'uncertain', code: string): void {
    this.db
      .update(t.orderDrafts)
      .set({ ttnState: state, ttnError: code, updatedAt: this.now() })
      .where(and(eq(t.orderDrafts.shopId, shopId), eq(t.orderDrafts.id, draftId), eq(t.orderDrafts.ttnState, 'creating')))
      .run();
  }

  /** A member checked the Nova Poshta cabinet and no parcel exists for an `uncertain` attempt: allow a new attempt. */
  releaseUncertainTtn(shopId: string, draftId: string): OrderDraft {
    const r = this.db
      .update(t.orderDrafts)
      .set({ ttnState: 'failed', ttnError: 'RELEASED_BY_MEMBER', updatedAt: this.now() })
      .where(and(eq(t.orderDrafts.shopId, shopId), eq(t.orderDrafts.id, draftId), eq(t.orderDrafts.ttnState, 'uncertain')))
      .run();
    if (!r.changes) throw new OrderStateError('no uncertain TTN attempt on this order');
    return this.getDraft(shopId, draftId)!;
  }

  /** Shipped orders to poll, oldest status first, across shops (the tracking job groups them by shop key). */
  listForTracking(limit = 500): OrderDraftRow[] {
    return this.db
      .select()
      .from(t.orderDrafts)
      .where(and(eq(t.orderDrafts.status, 'shipped'), sql`${t.orderDrafts.ttn} is not null`))
      .orderBy(sql`${t.orderDrafts.npStatusAt} is not null`, asc(t.orderDrafts.npStatusAt))
      .limit(limit)
      .all();
  }

  /**
   * Applies one Nova Poshta tracking status. Idempotent: the status text is refreshed, and a transition happens only
   * from `shipped`, once. `returning` never touches stock; when the recipient refused, it records one refusal (per order).
   */
  applyTracking(shopId: string, draftId: string, s: { code: string; text: string; outcome: 'delivered' | 'returning' | null; refusal: boolean }): { transition: 'delivered' | 'returning' | null } {
    return this.handle.raw.transaction(() => {
      const cur = this.getDraft(shopId, draftId)?.draft;
      if (!cur) throw new OrderNotFoundError();
      const set = { npStatusCode: s.code, npStatusText: s.text.slice(0, 300), npStatusAt: this.now() };
      if (cur.status === 'shipped' && s.outcome && this.move(shopId, draftId, 'shipped', s.outcome, 'provider:nova_poshta', `NP status ${s.code}`, set)) {
        if (s.outcome === 'returning' && s.refusal) this.delivery.recordProviderRefusal(shopId, { draftId, customerId: cur.customerId, phone: cur.recipientPhone });
        return { transition: s.outcome };
      }
      this.db.update(t.orderDrafts).set(set).where(and(eq(t.orderDrafts.shopId, shopId), eq(t.orderDrafts.id, draftId))).run();
      return { transition: null };
    })();
  }

  /** A member confirms the parcel is back: `returning` to `returned`, stock restored exactly once unless skipped. */
  markReturned(shopId: string, draftId: string, userId: string, opts: { restock?: boolean; note?: string } = {}): OrderDraft {
    const n = parse(decisionNote, opts.note);
    return this.handle.raw.transaction(() => {
      const cur = this.getDraft(shopId, draftId)?.draft;
      if (!cur) throw new OrderNotFoundError();
      const restock = opts.restock !== false;
      if (!this.move(shopId, draftId, 'returning', 'returned', `user:${userId}`, n || (restock ? null : 'returned without restock'))) throw new OrderStateError(`an order in status ${cur.status} cannot be marked returned`);
      if (restock) this.restock(shopId, draftId);
      return this.getDraft(shopId, draftId)!;
    })();
  }

  private requirePending(shopId: string, draftId: string): OrderDraftRow {
    const cur = this.getDraft(shopId, draftId);
    if (!cur) throw new OrderNotFoundError();
    if (cur.draft.status !== 'pending_approval') throw new OrderStateError(`draft is already ${cur.draft.status}`);
    return cur.draft;
  }
}
