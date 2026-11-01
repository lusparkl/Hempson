import type { CustomerNoticeEvent, CustomerNoticeRepository, CustomerNoticeRow, OrderDraftRow, OrderRepository, ShopRepository } from '@hepson/database';
import type { Notifier } from './notifier';
import type { CustomerSender } from './payments';

type Logger = { info(o: object, m?: string): void; warn(o: object, m?: string): void };

/** A notice not sent within this time after its status change (the server was down) is skipped: old news confuses. */
const MAX_AGE_MS = 24 * 3600_000;

export type CustomerNoticeServiceDeps = {
  repo: CustomerNoticeRepository;
  orders: OrderRepository;
  shops: ShopRepository;
  send: CustomerSender;
  log: Logger;
  notifier?: Notifier;
  clock?: () => Date;
};

const money = (minor: number, currency: string, uk: boolean) => {
  const n = minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
  return currency === 'UAH' ? `${n} ${uk ? 'грн' : 'UAH'}` : `${n} ${currency}`;
};

/**
 * Fixed customer texts (P6): the model never writes them. Ukrainian for `uk` shops, English otherwise. Every value comes
 * from the stored order: the server total, the Nova Poshta city and branch picked from NP lookups, the TTN NP returned.
 * Null when the order lacks what the text needs.
 */
export function noticeText(event: CustomerNoticeEvent, d: OrderDraftRow, language: string): string | null {
  const uk = language.toLowerCase().startsWith('uk');
  const id = d.id.slice(0, 8);
  const amount = money(d.totalMinor, d.currency, uk);
  const branch = d.npCityName && d.npWarehouseName ? `${d.npCityName}, ${d.npWarehouseName}` : null;
  switch (event) {
    case 'confirmed':
      if (!branch) return null;
      return uk
        ? `Замовлення ${id} підтверджено. Сума: ${amount}, оплата при отриманні (накладений платіж).\nДоставка: Нова Пошта, ${branch}.\nНомер ТТН надішлемо, щойно оформимо відправку.`
        : `Order ${id} is confirmed. Total: ${amount}, cash on delivery.\nDelivery: Nova Poshta, ${branch}.\nWe will send the TTN number once the parcel is booked.`;
    case 'rejected':
      return uk
        ? `На жаль, магазин не може підтвердити замовлення ${id}. Якщо маєте питання, напишіть нам тут.`
        : `Unfortunately the shop cannot confirm order ${id}. If you have questions, write to us here.`;
    case 'paid':
      return uk
        ? `Оплату за замовлення ${id} отримано: ${amount}. Дякуємо!\nНомер ТТН надішлемо, щойно оформимо відправку.`
        : `Payment for order ${id} received: ${amount}. Thank you!\nWe will send the TTN number once the parcel is booked.`;
    case 'shipped':
      if (!d.ttn) return null;
      return uk
        ? `Замовлення ${id} оформлено до відправки Новою Поштою.\nНомер ТТН: ${d.ttn}${branch ? `\nВідділення: ${branch}.` : ''}`
        : `Order ${id} is booked with Nova Poshta.\nTTN number: ${d.ttn}${branch ? `\nBranch: ${branch}.` : ''}`;
    case 'delivered':
      return uk ? `Замовлення ${id} отримано. Дякуємо за покупку!` : `Order ${id} has been received. Thank you for your purchase!`;
  }
}

/**
 * Sends the queued customer notices (P6). The row was written with the status change; this claims it, makes one attempt
 * through the conversation's channel (Instagram's 24-hour window and connection are checked before anything is sent)
 * and records the outcome. `uncertain` is final. A notice that could not reach the customer is passed to the shop.
 */
export class CustomerNoticeService {
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  constructor(private d: CustomerNoticeServiceDeps) {}

  private now() {
    return (this.d.clock ?? (() => new Date()))();
  }

  /** At startup: notices a crash left mid-send become `uncertain`, then whatever is still pending goes out. */
  start(): void {
    const n = this.d.repo.recoverInterrupted();
    if (n) this.d.log.warn({ count: n }, 'customer notices interrupted mid-send marked uncertain');
    this.kick();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Starts a sending pass, or asks the running one to look again when it ends. Never throws. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.drain()
      .catch((e) => this.d.log.warn({ code: e instanceof Error ? e.name : 'ERROR' }, 'customer notice pass failed'))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Resolves when no pass is running or queued (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const batch = this.d.repo.listPending();
      if (!batch.length || this.stopped) return;
      for (const n of batch) {
        if (this.stopped) return;
        if (this.d.repo.claim(n.shopId, n.id)) await this.sendOne(n);
      }
    }
  }

  private async sendOne(n: CustomerNoticeRow): Promise<void> {
    const { repo, log } = this.d;
    const d = this.d.orders.getDraft(n.shopId, n.draftId)?.draft;
    const skip = (code: string) => {
      repo.finish(n.shopId, n.id, 'skipped', code);
      log.info({ shopId: n.shopId, draftId: n.draftId, event: n.event, code }, 'customer notice skipped');
    };
    if (!d) return skip('NOT_FOUND');
    if (this.now().getTime() - Date.parse(n.createdAt) > MAX_AGE_MS) return skip('STALE');
    if (d.status === 'cancelled' && n.event !== 'rejected') return skip('ORDER_CANCELLED');
    const text = noticeText(n.event, d, this.d.shops.get(n.shopId)?.defaultLanguage ?? 'uk');
    if (!text) return skip('MISSING_DATA');
    let r: { status: 'sent' | 'uncertain' | 'failed'; code: string | null };
    try {
      r = await this.d.send(n.shopId, d.conversationId, text, `notice:${n.id}`);
    } catch {
      r = { status: 'failed', code: 'SEND_ERROR' };
    }
    repo.finish(n.shopId, n.id, r.status, r.code);
    if (r.status === 'sent') return;
    log.warn({ shopId: n.shopId, draftId: n.draftId, event: n.event, status: r.status, code: r.code }, 'customer notice not delivered');
    // The customer did not get it (Instagram window closed, channel disconnected): the shop tells them another way.
    if (r.status === 'failed')
      this.d.notifier?.notify({
        kind: 'order_update',
        shopId: n.shopId,
        conversationId: d.conversationId,
        draftId: d.id,
        event: 'customer_notice_undeliverable',
        ttn: d.ttn,
        notice: n.event,
        reason: r.code,
      });
  }
}
