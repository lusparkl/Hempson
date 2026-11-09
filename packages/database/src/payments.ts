import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CredentialVault } from './credentials';
import type { Db, DbHandle } from './db';
import { OrderRepository } from './orders';
import type { PAYMENT_PROVIDERS, PAYMENT_STATES } from './order-kinds';
import { orderedId } from './ids';
import * as t from './schema';

export type PaymentSettingsRow = typeof t.shopPaymentSettings.$inferSelect;
export type OrderPaymentRow = typeof t.orderPayments.$inferSelect;
export type PaymentEventRow = typeof t.paymentEvents.$inferSelect;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
export type PaymentState = (typeof PAYMENT_STATES)[number];
/** Invoice statuses as the provider reports them (Monobank `InvoiceStatusResponse.status`). */
export const PROVIDER_STATUSES = ['created', 'processing', 'hold', 'success', 'failure', 'reversed', 'expired'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export class PaymentValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid payment input: ${issues.join('; ')}`);
    this.name = 'PaymentValidationError';
  }
}
/** The order or payment is not in a state that allows the change. */
export class PaymentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentStateError';
  }
}

/** ISO 4217 numeric codes of the currencies Hepson sends to providers. Only hryvnia for now. */
export const CURRENCY_NUMERIC: Record<string, number> = { UAH: 980 };

const settingsInput = z
  .strictObject({
    paymentTimeoutHours: z.number().int().min(1).max(720).optional(),
    reminderHoursBefore: z.number().int().min(0).max(719).optional(),
  })
  .strict();

/** Later in the provider's life cycle wins when two events carry the same time (or no time). */
const RANK: Record<ProviderStatus, number> = { created: 0, processing: 1, hold: 2, failure: 3, expired: 3, success: 4, reversed: 5 };
/** States in which the attempt can still be paid, or is paid: the order has no room for another link. */
const ACTIVE: ProviderStatus[] = ['created', 'processing', 'hold', 'success', 'reversed'];
const OPEN_STATES: PaymentState[] = ['created', 'processing', 'hold'];

export type ProviderEvent = {
  invoiceId: string;
  status: ProviderStatus;
  amountMinor: number;
  ccy: number;
  /** Provider `modifiedDate`, as sent. */
  modifiedAt: string | null;
  finalAmountMinor: number | null;
  errCode: string | null;
  source: 'webhook' | 'status';
};
/**
 * What applying a provider status did. `paid`: the order moved to `paid`. `paid_after_cancel`: money arrived for an order
 * that is no longer waiting for it. `mismatch`: amount or currency differ from the order (nothing applied). `duplicate`
 * and `stale`: a replay or an older event (nothing applied). `unknown_invoice`: not a payment of this shop.
 */
export type ApplyOutcome = 'paid' | 'paid_after_cancel' | 'mismatch' | 'failed' | 'expired' | 'reversed' | 'updated' | 'duplicate' | 'stale' | 'unknown_invoice';

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
const time = (s: string | null) => (s ? Date.parse(s) : Number.NaN);

/**
 * Payment links and provider events (P5, D24). Hepson never holds money: it records invoices created with the shop's own
 * merchant token and moves an order to `paid` only from a verified provider status whose invoice, amount and currency
 * match. Every method takes `shopId` first and filters by it (the webhook lookup by opaque id is the one exception).
 */
export class PaymentRepository {
  readonly db: Db;
  private readonly orders: OrderRepository;
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
    this.orders = new OrderRepository(handle, clock);
  }
  private now() {
    return this.clock().toISOString();
  }

  // ---------- settings ----------

  async getSettings(shopId: string): Promise<PaymentSettingsRow> {
    return this.getSettingsTx(shopId);
  }

  /** Sync body of `getSettings`: runs inside the caller's transaction. Package-internal. */
  getSettingsTx(shopId: string): PaymentSettingsRow {
    return (
      this.db.select().from(t.shopPaymentSettings).where(eq(t.shopPaymentSettings.shopId, shopId)).get() ?? {
        shopId,
        webhookId: null,
        merchantId: null,
        merchantName: null,
        providerPubKey: null,
        providerPubKeyAt: null,
        paymentTimeoutHours: 24,
        reminderHoursBefore: 6,
        lastError: null,
        updatedAt: '',
      }
    );
  }

  private write(shopId: string, patch: Partial<Omit<PaymentSettingsRow, 'shopId'>>): PaymentSettingsRow {
    const row = { ...this.getSettingsTx(shopId), ...patch, shopId, updatedAt: this.now() };
    const { shopId: _s, ...set } = row;
    this.db.insert(t.shopPaymentSettings).values(row).onConflictDoUpdate({ target: t.shopPaymentSettings.shopId, set }).run();
    return row;
  }

  async updateSettings(shopId: string, input: z.input<typeof settingsInput>): Promise<PaymentSettingsRow> {
    const r = settingsInput.safeParse(input);
    if (!r.success) throw new PaymentValidationError(issues(r.error));
    const next = { ...this.getSettingsTx(shopId), ...Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined)) };
    if (next.reminderHoursBefore >= next.paymentTimeoutHours) throw new PaymentValidationError(['reminderHoursBefore: must be less than paymentTimeoutHours']);
    return this.write(shopId, { paymentTimeoutHours: next.paymentTimeoutHours, reminderHoursBefore: next.reminderHoursBefore });
  }

  /** Stores the Monobank token and the provider settings as one atomic step. */
  async connect(
    shopId: string,
    p: { webhookId: string; merchantId: string | null; merchantName: string | null; pubKey: string },
    vault: CredentialVault,
    token: string,
  ): Promise<void> {
    this.handle.transaction(() => {
      vault.saveTx(shopId, 'monobank', token);
      this.setProviderTx(shopId, p);
    });
  }

  /** Merchant identity, public key and a fresh webhook id, saved when the owner connects the provider token. */
  async setProvider(shopId: string, p: { webhookId: string; merchantId: string | null; merchantName: string | null; pubKey: string }): Promise<PaymentSettingsRow> {
    return this.setProviderTx(shopId, p);
  }

  /** Sync body of `setProvider`: runs inside the caller's transaction. Package-internal. */
  setProviderTx(shopId: string, p: { webhookId: string; merchantId: string | null; merchantName: string | null; pubKey: string }): PaymentSettingsRow {
    return this.write(shopId, {
      webhookId: p.webhookId,
      merchantId: p.merchantId,
      merchantName: p.merchantName,
      providerPubKey: p.pubKey,
      providerPubKeyAt: this.now(),
      lastError: null,
    });
  }

  async setPubKey(shopId: string, pubKey: string): Promise<void> {
    this.write(shopId, { providerPubKey: pubKey, providerPubKeyAt: this.now() });
  }

  async setLastError(shopId: string, code: string | null): Promise<void> {
    this.write(shopId, { lastError: code });
  }

  /** The shop a webhook path belongs to. Not shop-scoped by design: the opaque id is the only thing the caller has. */
  async findByWebhookId(webhookId: string): Promise<PaymentSettingsRow | undefined> {
    return this.db.select().from(t.shopPaymentSettings).where(eq(t.shopPaymentSettings.webhookId, webhookId)).get();
  }

  // ---------- payment attempts ----------

  /**
   * Claims a new payment link for an unpaid prepaid order: refused while another attempt is active (the partial unique
   * index makes two concurrent claims impossible). The amount and currency are the order's, computed by the server.
   */
  async claim(shopId: string, draftId: string, p: { provider: PaymentProvider; expiresAt: string }): Promise<OrderPaymentRow> {
    return this.handle.transaction(() => {
      const d = this.orders.getDraftTx(shopId, draftId)?.draft;
      if (!d) throw new PaymentStateError('order not found');
      if (d.status !== 'awaiting_payment' || d.paymentMethod !== 'prepaid') throw new PaymentStateError(`no payment link can be created for an order in status ${d.status}`);
      const cur = this.activeForTx(shopId, draftId);
      if (cur) throw new PaymentStateError(cur.state === 'creating' ? 'the payment link is being created' : 'this order already has a payment link');
      const ts = this.now();
      const row: OrderPaymentRow = {
        id: orderedId(),
        shopId,
        draftId,
        provider: p.provider,
        state: 'creating',
        active: true,
        invoiceId: null,
        pageUrl: null,
        amountMinor: d.totalMinor,
        currency: d.currency,
        providerModifiedAt: null,
        finalAmountMinor: null,
        providerErrCode: null,
        flag: null,
        expiresAt: p.expiresAt,
        linkSentAt: null,
        linkDelivery: null,
        lastCheckedAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
      this.db.insert(t.orderPayments).values(row).run();
      return row;
    });
  }

  async completeCreate(shopId: string, paymentId: string, inv: { invoiceId: string; pageUrl: string }): Promise<OrderPaymentRow> {
    const r = this.db
      .update(t.orderPayments)
      .set({ state: 'created', invoiceId: inv.invoiceId, pageUrl: inv.pageUrl, updatedAt: this.now() })
      .where(and(eq(t.orderPayments.shopId, shopId), eq(t.orderPayments.id, paymentId), eq(t.orderPayments.state, 'creating')))
      .returning()
      .get();
    if (!r) throw new PaymentStateError('no payment link creation in progress');
    return r;
  }

  /** No invoice is known for this attempt: it stops being active, so a member (or a later call) may create a new link. */
  async failCreate(shopId: string, paymentId: string, code: string): Promise<void> {
    this.db
      .update(t.orderPayments)
      .set({ state: 'create_failed', active: false, flag: code, updatedAt: this.now() })
      .where(and(eq(t.orderPayments.shopId, shopId), eq(t.orderPayments.id, paymentId), eq(t.orderPayments.state, 'creating')))
      .run();
  }

  /** Claims the one link message of an attempt (compare-and-set). */
  async claimLinkMessage(shopId: string, paymentId: string): Promise<boolean> {
    const r = this.db
      .update(t.orderPayments)
      .set({ linkSentAt: this.now(), updatedAt: this.now() })
      .where(and(eq(t.orderPayments.shopId, shopId), eq(t.orderPayments.id, paymentId), sql`${t.orderPayments.linkSentAt} is null`, sql`${t.orderPayments.pageUrl} is not null`))
      .run();
    return r.changes > 0;
  }

  async setLinkDelivery(shopId: string, paymentId: string, outcome: string): Promise<void> {
    this.db
      .update(t.orderPayments)
      .set({ linkDelivery: outcome.slice(0, 64), updatedAt: this.now() })
      .where(and(eq(t.orderPayments.shopId, shopId), eq(t.orderPayments.id, paymentId)))
      .run();
  }

  /** The unpaid invoice was deactivated at the provider (order cancelled or expired). */
  async markRemoved(shopId: string, paymentId: string): Promise<void> {
    this.db
      .update(t.orderPayments)
      .set({ state: 'removed', active: false, updatedAt: this.now() })
      .where(and(eq(t.orderPayments.shopId, shopId), eq(t.orderPayments.id, paymentId), inArray(t.orderPayments.state, ['created', 'processing', 'hold'])))
      .run();
  }

  async markChecked(shopId: string, paymentId: string): Promise<void> {
    this.db
      .update(t.orderPayments)
      .set({ lastCheckedAt: this.now() })
      .where(and(eq(t.orderPayments.shopId, shopId), eq(t.orderPayments.id, paymentId)))
      .run();
  }

  async get(shopId: string, paymentId: string): Promise<OrderPaymentRow | undefined> {
    return this.db
      .select()
      .from(t.orderPayments)
      .where(and(eq(t.orderPayments.shopId, shopId), eq(t.orderPayments.id, paymentId)))
      .get();
  }

  async activeFor(shopId: string, draftId: string): Promise<OrderPaymentRow | undefined> {
    return this.activeForTx(shopId, draftId);
  }

  /** Sync body of `activeFor`: runs inside the caller's transaction. Package-internal. */
  activeForTx(shopId: string, draftId: string): OrderPaymentRow | undefined {
    return this.db
      .select()
      .from(t.orderPayments)
      .where(and(eq(t.orderPayments.shopId, shopId), eq(t.orderPayments.draftId, draftId), eq(t.orderPayments.active, true)))
      .get();
  }

  /** The newest attempt of each order, for order views. */
  async latestFor(shopId: string, draftIds: string[]): Promise<Map<string, OrderPaymentRow>> {
    const out = new Map<string, OrderPaymentRow>();
    if (!draftIds.length) return out;
    const rows = this.db
      .select()
      .from(t.orderPayments)
      .where(and(eq(t.orderPayments.shopId, shopId), inArray(t.orderPayments.draftId, draftIds)))
      .orderBy(desc(t.orderPayments.createdAt), desc(t.orderPayments.id))
      .all();
    for (const r of rows) if (!out.has(r.draftId)) out.set(r.draftId, r);
    return out;
  }

  async listFor(shopId: string, draftId: string): Promise<OrderPaymentRow[]> {
    return this.db
      .select()
      .from(t.orderPayments)
      .where(and(eq(t.orderPayments.shopId, shopId), eq(t.orderPayments.draftId, draftId)))
      .orderBy(asc(t.orderPayments.createdAt), asc(t.orderPayments.id))
      .all();
  }

  async listEvents(shopId: string, paymentId: string): Promise<PaymentEventRow[]> {
    return this.db
      .select()
      .from(t.paymentEvents)
      .where(and(eq(t.paymentEvents.shopId, shopId), eq(t.paymentEvents.paymentId, paymentId)))
      .orderBy(asc(t.paymentEvents.createdAt), asc(t.paymentEvents.id))
      .all();
  }

  /** Open invoices across shops for the reconciliation job, least recently checked first. */
  async listToReconcile(createdBefore: string, limit = 200): Promise<OrderPaymentRow[]> {
    return this.db
      .select()
      .from(t.orderPayments)
      .where(and(inArray(t.orderPayments.state, OPEN_STATES), sql`${t.orderPayments.invoiceId} is not null`, sql`${t.orderPayments.createdAt} <= ${createdBefore}`))
      .orderBy(sql`${t.orderPayments.lastCheckedAt} is not null`, asc(t.orderPayments.lastCheckedAt))
      .limit(limit)
      .all();
  }

  /**
   * Applies one provider status (a verified webhook or a status call). Idempotent and order-safe:
   * - a replay (same invoice, status and `modifiedDate`) is a no-op;
   * - an event older than the last applied one changes nothing, and a paid invoice only moves on to `reversed`;
   * - amount or currency different from the stored attempt: nothing applied, the attempt is flagged (`mismatch`);
   * - `success` moves the order `awaiting_payment` to `paid` (`provider:<name>`) in the same transaction.
   */
  async applyStatus(shopId: string, provider: PaymentProvider, ev: ProviderEvent): Promise<{ outcome: ApplyOutcome; payment: OrderPaymentRow | null }> {
    return this.handle.transaction(() => {
      const pay = this.db
        .select()
        .from(t.orderPayments)
        .where(and(eq(t.orderPayments.shopId, shopId), eq(t.orderPayments.provider, provider), eq(t.orderPayments.invoiceId, ev.invoiceId)))
        .get();
      const verdict: PaymentEventRow['verdict'] = !pay
        ? 'unknown_invoice'
        : ev.amountMinor !== pay.amountMinor || ev.ccy !== CURRENCY_NUMERIC[pay.currency]
          ? 'mismatch'
          : this.isNewer(pay, ev)
            ? 'applied'
            : 'stale';
      const ins = this.db
        .insert(t.paymentEvents)
        .values({
          id: orderedId(),
          shopId,
          paymentId: pay?.id ?? null,
          provider,
          invoiceId: ev.invoiceId,
          status: ev.status,
          providerModifiedAt: ev.modifiedAt ?? '',
          amountMinor: ev.amountMinor,
          ccy: ev.ccy,
          source: ev.source,
          verdict,
          createdAt: this.now(),
        })
        .onConflictDoNothing()
        .run();
      if (!ins.changes) return { outcome: 'duplicate' as const, payment: pay ?? null };
      if (!pay) return { outcome: 'unknown_invoice' as const, payment: null };
      if (verdict === 'mismatch') {
        const p = this.db.update(t.orderPayments).set({ flag: 'AMOUNT_MISMATCH', updatedAt: this.now() }).where(eq(t.orderPayments.id, pay.id)).returning().get()!;
        return { outcome: 'mismatch' as const, payment: p };
      }
      if (verdict === 'stale') return { outcome: 'stale' as const, payment: pay };
      const p = this.db
        .update(t.orderPayments)
        .set({
          state: ev.status,
          // An attempt that stopped being active never becomes active again: a newer attempt may hold the slot.
          active: pay.active && ACTIVE.includes(ev.status),
          providerModifiedAt: ev.modifiedAt ?? pay.providerModifiedAt,
          finalAmountMinor: ev.finalAmountMinor ?? pay.finalAmountMinor,
          providerErrCode: ev.errCode ? ev.errCode.slice(0, 32) : pay.providerErrCode,
          updatedAt: this.now(),
        })
        .where(eq(t.orderPayments.id, pay.id))
        .returning()
        .get()!;
      if (ev.status === 'success') {
        if (this.orders.markPaidTx(shopId, pay.draftId, `provider:${provider}`, `invoice ${ev.invoiceId}`)) return { outcome: 'paid' as const, payment: p };
        const status = this.orders.getDraftTx(shopId, pay.draftId)?.draft.status;
        if (status === 'cancelled' || status === 'rejected') {
          const flagged = this.db.update(t.orderPayments).set({ flag: 'PAID_AFTER_CANCEL', updatedAt: this.now() }).where(eq(t.orderPayments.id, pay.id)).returning().get()!;
          return { outcome: 'paid_after_cancel' as const, payment: flagged };
        }
        return { outcome: 'updated' as const, payment: p };
      }
      const outcome: ApplyOutcome = ev.status === 'failure' ? 'failed' : ev.status === 'expired' ? 'expired' : ev.status === 'reversed' ? 'reversed' : 'updated';
      return { outcome, payment: p };
    });
  }

  /** Whether `ev` comes after the last applied status of this attempt. */
  private isNewer(pay: OrderPaymentRow, ev: ProviderEvent): boolean {
    if (pay.state === 'reversed') return false;
    if (pay.state === 'success') return ev.status === 'reversed';
    // Hepson deactivated this invoice; only money that moved anyway still counts (and is escalated by the caller).
    if (pay.state === 'removed' && ev.status !== 'success') return false;
    const rankUp = RANK[ev.status] > (RANK[pay.state as ProviderStatus] ?? -1);
    const a = time(ev.modifiedAt);
    const b = time(pay.providerModifiedAt);
    if (Number.isNaN(b)) return true;
    if (Number.isNaN(a)) return rankUp;
    return a > b || (a === b && rankUp);
  }
}
