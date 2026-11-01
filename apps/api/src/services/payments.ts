import { randomBytes } from 'node:crypto';
import { ConnectorError } from '@hepson/connector-core';
import {
  CURRENCY_NUMERIC,
  CredentialDecryptError,
  CredentialMissingError,
  CredentialsUnavailableError,
  PaymentStateError,
  type AgentRepository,
  type CredentialVault,
  type OrderDraft,
  type OrderPaymentRow,
  type OrderRepository,
  type PaymentRepository,
  type ShopRepository,
} from '@hepson/database';
import type { DeliveryService } from './delivery';
import { EgressDeniedError } from './egress';
import { MonobankError, parseInvoiceStatus, verifyMonobankSignature, type MonobankApi, type MonoInvoiceStatus } from './monobank';
import type { Notifier, OrderEvent } from './notifier';

type Logger = { info(o: object, m?: string): void; warn(o: object, m?: string): void };
/** Sends a fixed server text to the customer of a conversation (recorded as a `system` message). */
export type CustomerSender = (shopId: string, conversationId: string, text: string, idempotencyKey: string) => Promise<{ status: 'sent' | 'uncertain' | 'failed'; code: string | null }>;

/** Printable ASCII, no spaces: what an X-Token can look like. Checked before any call. */
const TOKEN_RE = /^[\x21-\x7e]{20,200}$/;
/** A failed signature refreshes the cached public key at most this often (a forged request cannot make Hepson spam Monobank). */
const PUBKEY_REFRESH_MS = 10 * 60_000;
/** A new link needs at least this much time before the order's payment deadline. */
const MIN_LINK_MS = 15 * 60_000;
/** A webhook normally arrives within seconds; the status call only picks up invoices older than this. */
const RECONCILE_AFTER_MS = 2 * 60_000;
/** An invoice still `processing` at the deadline gets this much longer before the order is cancelled. */
const PROCESSING_GRACE_MS = 60 * 60_000;

export type PaymentServiceDeps = {
  api: MonobankApi;
  vault: CredentialVault;
  repo: PaymentRepository;
  orders: OrderRepository;
  agent: AgentRepository;
  shops: ShopRepository;
  delivery: DeliveryService;
  send: CustomerSender;
  log: Logger;
  /** Public https base URL of this API; without it no webhook URL is given and reconciliation alone finds payments. */
  publicUrl: string;
  notifier?: Notifier;
  clock?: () => Date;
};

const uah = (minor: number) => (minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2));
/** Kyiv wall-clock time as `dd.mm HH:MM`. */
function kyivTime(iso: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

/**
 * Fixed customer texts (D24: the link is never model-composed). Ukrainian for `uk` shops, English otherwise. The amount is
 * the order total stored by the server, the URL is the payment page Monobank returned.
 */
export function paymentText(kind: 'link' | 'reminder', p: { language: string; orderId: string; amountMinor: number; url: string; expiresAt: string }): string {
  const uk = p.language.toLowerCase().startsWith('uk');
  const id = p.orderId.slice(0, 8);
  const until = kyivTime(p.expiresAt);
  if (kind === 'link')
    return uk
      ? `Замовлення ${id} підтверджено. До сплати: ${uah(p.amountMinor)} грн.\nОплатити карткою через monobank: ${p.url}\nПосилання дійсне до ${until} (за київським часом).`
      : `Order ${id} is confirmed. Amount due: ${uah(p.amountMinor)} UAH.\nPay by card via monobank: ${p.url}\nThe link is valid until ${until} (Kyiv time).`;
  return uk
    ? `Нагадуємо: замовлення ${id} ще не оплачене (${uah(p.amountMinor)} грн).\nОплатити: ${p.url}\nПосилання дійсне до ${until} (за київським часом), після цього замовлення буде скасоване.`
    : `Reminder: order ${id} is not paid yet (${uah(p.amountMinor)} UAH).\nPay here: ${p.url}\nThe link is valid until ${until} (Kyiv time); after that the order is cancelled.`;
}

/**
 * Monobank payment links for one shop at a time (P5, D24): the shop's own acquiring token (vault kind `monobank`, D28),
 * one invoice per unpaid prepaid order created by server code, a fixed-template link message, signed webhooks, a
 * reconciliation job, the payment deadline (cancel with restock) and one reminder. `paid` only from a verified provider
 * status whose invoice, amount and currency match the order; the model has no part in any of it.
 */
export class PaymentService {
  private inflight = new Set<Promise<unknown>>();
  constructor(private d: PaymentServiceDeps) {}

  private now() {
    return (this.d.clock ?? (() => new Date()))();
  }
  get available(): boolean {
    return this.d.vault.available;
  }
  connected(shopId: string): boolean {
    return this.available && this.d.vault.get(shopId, 'monobank')?.status === 'active';
  }

  private webhookUrl(webhookId: string | null): string | null {
    return webhookId && this.d.publicUrl.startsWith('https://') ? `${this.d.publicUrl}/webhooks/monobank/${webhookId}` : null;
  }

  /** Non-secret state for the dashboard. */
  status(shopId: string) {
    const s = this.d.repo.getSettings(shopId);
    const cred = this.available ? this.d.vault.get(shopId, 'monobank') : undefined;
    return {
      available: this.available,
      provider: 'monobank' as const,
      status: cred ? (cred.status === 'active' ? ('connected' as const) : ('needs_reconnect' as const)) : ('not_connected' as const),
      merchantName: s.merchantName,
      webhookReady: this.webhookUrl(s.webhookId) !== null,
      paymentTimeoutHours: s.paymentTimeoutHours,
      reminderHoursBefore: s.reminderHoursBefore,
      lastError: s.lastError,
      updatedAt: s.updatedAt || null,
    };
  }

  /** Runs one Monobank call with the shop's token. A refused token marks the credential and tells the owner once. */
  private async withToken<T>(shopId: string, fn: (token: string) => Promise<T>): Promise<T> {
    if (!this.available) throw new ConnectorError('NOT_CONFIGURED', 'Credential storage is not configured on this server');
    if (!this.connected(shopId)) throw new ConnectorError('NOT_CONFIGURED', 'Monobank is not connected for this shop');
    try {
      return await this.d.vault.withSecret(shopId, 'monobank', fn);
    } catch (e) {
      if (e instanceof MonobankError && e.kind === 'auth') {
        this.d.vault.mark(shopId, 'monobank', 'needs_reconnect');
        this.d.repo.setLastError(shopId, 'TOKEN_REJECTED');
        this.d.notifier?.notify({ kind: 'channel_issue', shopId, channel: 'monobank', issue: 'needs_reconnect' });
      }
      if (e instanceof CredentialMissingError || e instanceof CredentialsUnavailableError || e instanceof CredentialDecryptError) throw new ConnectorError('NOT_CONFIGURED', 'Monobank is not connected for this shop');
      throw e;
    }
  }

  private translate(e: unknown): never {
    if (e instanceof MonobankError) {
      if (e.kind === 'auth') throw new ConnectorError('VALIDATION_ERROR', 'Monobank did not accept the token');
      if (e.kind === 'unavailable') throw new ConnectorError('TEMPORARY_FAILURE', 'Monobank is not reachable, try again');
      throw new ConnectorError('VALIDATION_ERROR', 'Monobank refused the request');
    }
    if (e instanceof PaymentStateError) throw new ConnectorError('VALIDATION_ERROR', e.message);
    throw e;
  }

  /** Checks the token by reading the merchant, fetches the webhook public key, then stores the token encrypted. */
  async connect(shopId: string, token: string): Promise<ReturnType<PaymentService['status']>> {
    if (!this.available) throw new ConnectorError('NOT_CONFIGURED', 'Credential storage is not configured on this server');
    if (!TOKEN_RE.test(token)) throw new ConnectorError('VALIDATION_ERROR', 'This is not a Monobank acquiring token');
    try {
      const me = await this.d.api.merchantDetails(token);
      const pubKey = await this.d.api.pubKey(token);
      this.d.repo.db.transaction(() => {
        this.d.vault.save(shopId, 'monobank', token);
        // A fresh webhook path per connection: a URL given to an earlier token stops matching.
        this.d.repo.setProvider(shopId, { webhookId: randomBytes(24).toString('base64url'), merchantId: me.merchantId, merchantName: me.merchantName, pubKey });
      });
      this.d.log.info({ shopId }, 'monobank connected');
      return this.status(shopId);
    } catch (e) {
      if (e instanceof MonobankError) this.d.log.warn({ shopId, kind: e.kind, code: e.code }, 'monobank connect failed');
      this.translate(e);
    }
  }

  /** Deletes the token. The public key and webhook path stay, so a payment already made is still recognised. */
  disconnect(shopId: string): void {
    if (this.available) this.d.vault.delete(shopId, 'monobank');
  }

  // ---------- links ----------

  /** Fire and forget after an approval: an order entering `awaiting_payment` gets its link. */
  afterApproval(shopId: string, d: OrderDraft): void {
    if (d.draft.status !== 'awaiting_payment') return;
    this.track(this.createLink(shopId, d.draft.id).catch(() => undefined));
  }

  /** Fire and forget after a member cancelled an order: its unpaid invoice is deactivated so nobody can pay it any more. */
  afterCancel(shopId: string, draftId: string): void {
    const p = this.d.repo.activeFor(shopId, draftId);
    if (!p?.invoiceId || !['created', 'processing', 'hold'].includes(p.state)) return;
    this.track(this.remove(shopId, p).catch(() => undefined));
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }

  /** Resolves when no link creation, message or reconciliation pass is in flight (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private notifyOrder(shopId: string, draftId: string, event: OrderEvent, link: string | null = null) {
    const d = this.d.orders.getDraft(shopId, draftId)?.draft;
    if (d) this.d.notifier?.notify({ kind: 'order_update', shopId, conversationId: d.conversationId, draftId, event, ttn: null, link });
  }

  /**
   * Creates the payment link of an unpaid prepaid order and sends it with the fixed text. The amount is the stored
   * order total; the link expires at the order's payment deadline. Refused while another link is active.
   */
  async createLink(shopId: string, draftId: string): Promise<OrderPaymentRow> {
    const { repo, orders, log } = this.d;
    const d = orders.getDraft(shopId, draftId)?.draft;
    if (!d) throw new ConnectorError('NOT_FOUND', 'order draft not found');
    const fail = (code: string, notify = true): never => {
      log.warn({ shopId, draftId, code }, 'payment link not created');
      if (notify) this.notifyOrder(shopId, draftId, 'payment_link_failed');
      throw new ConnectorError(code === 'NOT_CONNECTED' ? 'NOT_CONFIGURED' : 'VALIDATION_ERROR', code === 'NOT_CONNECTED' ? 'Monobank is not connected for this shop' : `The payment link could not be created (${code})`);
    };
    if (!this.connected(shopId)) fail('NOT_CONNECTED');
    if (CURRENCY_NUMERIC[d.currency] === undefined) fail('CURRENCY_NOT_SUPPORTED');
    const due = d.paymentDueAt ? Date.parse(d.paymentDueAt) : this.now().getTime() + repo.getSettings(shopId).paymentTimeoutHours * 3600_000;
    const left = due - this.now().getTime();
    if (left < MIN_LINK_MS) fail('DEADLINE_TOO_CLOSE');
    let pay: OrderPaymentRow;
    try {
      pay = repo.claim(shopId, draftId, { provider: 'monobank', expiresAt: new Date(due).toISOString() });
    } catch (e) {
      this.translate(e);
    }
    try {
      const inv = await this.withToken(shopId, (token) =>
        this.d.api.createInvoice(token, {
          amountMinor: pay.amountMinor,
          ccy: CURRENCY_NUMERIC[pay.currency]!,
          reference: draftId,
          destination: `Замовлення ${draftId.slice(0, 8)}`,
          validitySec: Math.floor(left / 1000),
          webHookUrl: this.webhookUrl(repo.getSettings(shopId).webhookId),
          redirectUrl: null,
        }),
      );
      pay = repo.completeCreate(shopId, pay.id, inv);
    } catch (e) {
      // Nobody has seen the page of an invoice whose answer was lost, so nobody can pay it: the slot is freed for a retry.
      const code = e instanceof MonobankError ? `MONO_${e.kind.toUpperCase()}${e.code ? `_${e.code}` : ''}` : e instanceof EgressDeniedError ? 'EGRESS_DENIED' : 'NOT_CONNECTED';
      repo.failCreate(shopId, pay.id, code.slice(0, 64));
      fail(code, true);
    }
    log.info({ shopId, draftId }, 'payment link created');
    await this.sendLink(shopId, pay, 'link');
    return repo.get(shopId, pay.id)!;
  }

  private async sendLink(shopId: string, pay: OrderPaymentRow, kind: 'link' | 'reminder'): Promise<void> {
    const d = this.d.orders.getDraft(shopId, pay.draftId)?.draft;
    if (!d || !pay.pageUrl) return;
    if (kind === 'link' && !this.d.repo.claimLinkMessage(shopId, pay.id)) return;
    const text = paymentText(kind, { language: this.d.shops.get(shopId)?.defaultLanguage ?? 'uk', orderId: d.id, amountMinor: pay.amountMinor, url: pay.pageUrl, expiresAt: pay.expiresAt });
    let r: { status: string; code: string | null };
    try {
      r = await this.d.send(shopId, d.conversationId, text, `payment-${kind}:${pay.id}`);
    } catch {
      r = { status: 'failed', code: 'SEND_ERROR' };
    }
    if (kind === 'link') this.d.repo.setLinkDelivery(shopId, pay.id, r.status === 'sent' ? 'sent' : `${r.status}:${r.code ?? ''}`);
    // The customer did not get it (Instagram window closed, channel disconnected): the shop gets the link to pass on.
    if (r.status === 'failed') this.notifyOrder(shopId, d.id, kind === 'link' ? 'payment_link_undeliverable' : 'payment_reminder_undeliverable', pay.pageUrl);
  }

  private async remove(shopId: string, p: OrderPaymentRow): Promise<boolean> {
    try {
      await this.withToken(shopId, (token) => this.d.api.removeInvoice(token, p.invoiceId!));
      this.d.repo.markRemoved(shopId, p.id);
      return true;
    } catch (e) {
      this.d.log.warn({ shopId, paymentId: p.id, code: e instanceof MonobankError ? `${e.kind}:${e.code ?? ''}` : e instanceof Error ? e.name : 'ERROR' }, 'monobank invoice not removed');
      return false;
    }
  }

  /** A member records a refund request (D24/D25); the shop is told to refund in the provider's cabinet. */
  refundRequested(shopId: string, draftId: string, userId: string, note?: string): OrderDraft {
    const d = this.d.orders.requestRefund(shopId, draftId, userId, note);
    this.notifyOrder(shopId, draftId, 'refund_requested');
    return d;
  }

  // ---------- provider events ----------

  /**
   * One webhook delivery. Returns false (the route answers 401 and nothing is stored) unless the `x-sign` signature over
   * the raw body verifies with this shop's cached Monobank key; a failure refreshes the key once (rate-limited) and retries.
   */
  async handleWebhook(webhookId: string, rawBody: Buffer, xSign: string | undefined): Promise<boolean> {
    const s = this.d.repo.findByWebhookId(webhookId);
    if (!s) return false;
    let ok = verifyMonobankSignature(rawBody, xSign, s.providerPubKey);
    const stale = !s.providerPubKeyAt || this.now().getTime() - Date.parse(s.providerPubKeyAt) > PUBKEY_REFRESH_MS;
    if (!ok && xSign && stale && this.connected(s.shopId)) {
      try {
        const key = await this.withToken(s.shopId, (token) => this.d.api.pubKey(token));
        this.d.repo.setPubKey(s.shopId, key);
        ok = verifyMonobankSignature(rawBody, xSign, key);
      } catch (e) {
        this.d.log.warn({ shopId: s.shopId, code: e instanceof MonobankError ? e.kind : 'ERROR' }, 'monobank public key refresh failed');
      }
    }
    if (!ok) {
      this.d.log.warn({ shopId: s.shopId }, 'monobank webhook signature rejected');
      return false;
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      body = null;
    }
    const st = parseInvoiceStatus(body);
    if (!st) {
      this.d.log.warn({ shopId: s.shopId }, 'monobank webhook body not understood');
      return true;
    }
    this.apply(s.shopId, st, 'webhook');
    return true;
  }

  /** Applies one verified status and does what the outcome needs: TTN, notices, escalations. */
  private apply(shopId: string, st: MonoInvoiceStatus, source: 'webhook' | 'status') {
    const r = this.d.repo.applyStatus(shopId, 'monobank', {
      invoiceId: st.invoiceId,
      status: st.status,
      amountMinor: st.amount,
      ccy: st.ccy,
      modifiedAt: st.modifiedDate,
      finalAmountMinor: st.finalAmount,
      errCode: st.errCode,
      source,
    });
    const p = r.payment;
    if (r.outcome !== 'duplicate' && r.outcome !== 'stale') this.d.log.info({ shopId, outcome: r.outcome, status: st.status, source }, 'monobank status');
    if (!p) return r;
    const conv = () => this.d.orders.getDraft(shopId, p.draftId)?.draft.conversationId;
    const escalate = (reason: string) => {
      const c = conv();
      if (!c) return;
      const e = this.d.agent.escalate(shopId, c, reason);
      if (e.created) this.d.notifier?.notify({ kind: 'escalation', shopId, conversationId: c, reason });
    };
    const id = p.draftId.slice(0, 8);
    if (r.outcome === 'paid') {
      this.notifyOrder(shopId, p.draftId, 'paid');
      this.d.delivery.afterPaid(shopId, p.draftId);
    } else if (r.outcome === 'mismatch') escalate(`Оплата monobank не збігається із замовленням ${id} (сума або валюта). Замовлення не позначено оплаченим, перевірте кабінет monobank.`);
    else if (r.outcome === 'paid_after_cancel') escalate(`Надійшла оплата monobank за скасоване замовлення ${id}. Перевірте замовлення і поверніть кошти в кабінеті monobank, якщо потрібно.`);
    else if (r.outcome === 'failed') this.notifyOrder(shopId, p.draftId, 'payment_failed');
    else if (r.outcome === 'reversed') this.notifyOrder(shopId, p.draftId, 'payment_reversed');
    return r;
  }

  /**
   * One pass of the payment job: asks Monobank for the status of open invoices (a lost webhook cannot strand an order),
   * sends the one reminder before the deadline, and cancels unpaid orders whose deadline passed (with restock). Safe to
   * run repeatedly and concurrently with webhooks: every change is compare-and-set.
   */
  async reconcileOnce(): Promise<{ checked: number; expired: number; reminded: number }> {
    return this.track(this.reconcile());
  }

  private async reconcile(): Promise<{ checked: number; expired: number; reminded: number }> {
    const { repo, orders } = this.d;
    const nowMs = this.now().getTime();
    let checked = 0;
    let expired = 0;
    let reminded = 0;
    const dead = new Set<string>();
    const check = async (p: OrderPaymentRow) => {
      if (dead.has(p.shopId) || !this.connected(p.shopId)) return;
      try {
        const st = await this.withToken(p.shopId, (token) => this.d.api.invoiceStatus(token, p.invoiceId!));
        checked++;
        this.apply(p.shopId, st, 'status');
      } catch (e) {
        if (e instanceof MonobankError && e.kind === 'auth') dead.add(p.shopId);
        this.d.log.warn({ shopId: p.shopId, code: e instanceof MonobankError ? `${e.kind}:${e.code ?? ''}` : e instanceof Error ? e.name : 'ERROR' }, 'monobank status check failed');
      } finally {
        repo.markChecked(p.shopId, p.id);
      }
    };
    for (const p of repo.listToReconcile(new Date(nowMs - RECONCILE_AFTER_MS).toISOString())) await check(p);

    for (const o of orders.listAwaitingPayment()) {
      const due = Date.parse(o.paymentDueAt!);
      const settings = repo.getSettings(o.shopId);
      let p = repo.activeFor(o.shopId, o.id);
      if (nowMs >= due) {
        if (p?.invoiceId && ['created', 'processing', 'hold'].includes(p.state)) {
          await check(p);
          if (orders.getDraft(o.shopId, o.id)?.draft.status !== 'awaiting_payment') continue;
          p = repo.get(o.shopId, p.id);
          // Money may be on its way: wait a little before cancelling.
          if (p && (p.state === 'processing' || p.state === 'hold') && nowMs < due + PROCESSING_GRACE_MS) continue;
          if (p && ['created', 'processing', 'hold'].includes(p.state)) await this.remove(o.shopId, p);
        }
        if (orders.expireUnpaid(o.shopId, o.id)) {
          expired++;
          this.notifyOrder(o.shopId, o.id, 'payment_expired');
        }
        continue;
      }
      // D25: one reminder, only for a link that was sent, `reminderHoursBefore` before the deadline (0 = none).
      const remindAt = due - settings.reminderHoursBefore * 3600_000;
      if (settings.reminderHoursBefore > 0 && nowMs >= remindAt && p?.state === 'created' && p.linkSentAt && !o.paymentReminderAt && orders.claimPaymentReminder(o.shopId, o.id)) {
        reminded++;
        await this.sendLink(o.shopId, p, 'reminder');
      }
    }
    return { checked, expired, reminded };
  }
}
