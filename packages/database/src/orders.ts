import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import * as t from './schema';

export type OrderDraftRow = typeof t.orderDrafts.$inferSelect;
export type OrderDraftItemRow = typeof t.orderDraftItems.$inferSelect;
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
  items: quoteInput,
});
const decisionNote = z.string().trim().max(500).optional();

export type CreateOrderDraftInput = z.input<typeof createInput>;
export type QuoteItemsInput = z.input<typeof quoteInput>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new OrderValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
  return r.data;
}

/**
 * Shop-scoped order drafts (Feature 7). Prices and totals come only from the catalog at draft time; a caller (including
 * the AI) supplies SKUs and quantities, never prices. Drafts start `pending_approval`; only `approve` (a human decision made
 * by the route layer) changes stock. Every method takes `shopId` first and filters by it. Internal: no authorization here.
 */
export class OrderRepository {
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
      const ts = this.now();
      if (v.createdBy === 'ai')
        this.db
          .update(t.orderDrafts)
          .set({ status: 'cancelled', decidedAt: ts, decisionNote: 'superseded by a newer draft', updatedAt: ts })
          .where(and(eq(t.orderDrafts.shopId, shopId), eq(t.orderDrafts.conversationId, conv.id), eq(t.orderDrafts.status, 'pending_approval'), eq(t.orderDrafts.createdBy, 'ai')))
          .run();
      const draft: OrderDraftRow = {
        id: randomUUID(),
        shopId,
        conversationId: conv.id,
        customerId: conv.customerId,
        status: 'pending_approval',
        createdBy: v.createdBy,
        runId: v.runId ?? null,
        contactName: v.contactName ?? null,
        contactPhone: v.contactPhone ?? null,
        deliveryInfo: v.deliveryInfo ?? null,
        note: v.note ?? null,
        currency: q.currency,
        totalMinor: q.totalMinor,
        decidedByUserId: null,
        decidedAt: null,
        decisionNote: null,
        createdAt: ts,
        updatedAt: ts,
      };
      this.db.insert(t.orderDrafts).values(draft).run();
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
   * Seller approval: all-or-nothing. Stock is checked and reduced atomically (conditional UPDATE per line); if any line
   * cannot be covered the whole approval fails and nothing changes. Approving an already decided draft is refused.
   */
  approve(shopId: string, draftId: string, userId: string, note?: string): OrderDraft {
    const n = parse(decisionNote, note);
    return this.handle.raw.transaction(() => {
      const cur = this.requirePending(shopId, draftId);
      const ts = this.now();
      for (const it of this.itemsOf(shopId, [cur.id])) {
        const ok = this.db
          .update(t.productVariants)
          .set({ stock: sql`${t.productVariants.stock} - ${it.quantity}`, updatedAt: ts })
          .where(and(eq(t.productVariants.shopId, shopId), eq(t.productVariants.id, it.variantId), eq(t.productVariants.active, true), sql`${t.productVariants.stock} >= ${it.quantity}`))
          .run();
        if (!ok.changes) throw new OrderStockError(it.sku);
      }
      return this.decide(shopId, cur.id, 'approved', userId, n);
    })();
  }

  reject(shopId: string, draftId: string, userId: string, note?: string): OrderDraft {
    const n = parse(decisionNote, note);
    return this.handle.raw.transaction(() => {
      const cur = this.requirePending(shopId, draftId);
      return this.decide(shopId, cur.id, 'rejected', userId, n);
    })();
  }

  private requirePending(shopId: string, draftId: string): OrderDraftRow {
    const cur = this.getDraft(shopId, draftId);
    if (!cur) throw new OrderNotFoundError();
    if (cur.draft.status !== 'pending_approval') throw new OrderStateError(`draft is already ${cur.draft.status}`);
    return cur.draft;
  }

  private decide(shopId: string, draftId: string, status: 'approved' | 'rejected', userId: string, note: string | undefined): OrderDraft {
    const ts = this.now();
    this.db
      .update(t.orderDrafts)
      .set({ status, decidedByUserId: userId, decidedAt: ts, decisionNote: note || null, updatedAt: ts })
      .where(and(eq(t.orderDrafts.shopId, shopId), eq(t.orderDrafts.id, draftId)))
      .run();
    return this.getDraft(shopId, draftId)!;
  }
}
