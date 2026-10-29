import type { AgentRepository, ConversationRepository, ShopRepository } from '@hepson/database';

type Logger = { warn(o: object, m?: string): void };

export type Notification =
  | { kind: 'escalation'; shopId: string; conversationId: string; reason: string }
  | { kind: 'order_draft'; shopId: string; conversationId: string; draftId: string; currency: string; totalMinor: number; itemCount: number };

/** Tells a shop's people that something needs them (Feature 8). Fire and forget: never throws, never blocks the caller. */
export interface Notifier {
  notify(n: Notification): void;
  /** Resolves when no delivery is in flight (tests, shutdown). */
  whenIdle(): Promise<void>;
}

const money = (minor: number, cur: string) => `${(minor / 100).toFixed(2)} ${cur}`;

/** Plain text, no markup (so customer-derived text cannot inject formatting). Ukrainian for `uk` shops, English otherwise. */
export function renderNotification(n: Notification, ctx: { shopName: string; language: string; customer: string }): string {
  const uk = ctx.language.toLowerCase().startsWith('uk');
  if (n.kind === 'escalation') {
    return uk
      ? `[${ctx.shopName}] ШІ передає розмову людині.\nКлієнт: ${ctx.customer}\nПричина: ${n.reason}`
      : `[${ctx.shopName}] The AI hands a conversation to a human.\nCustomer: ${ctx.customer}\nReason: ${n.reason}`;
  }
  const total = money(n.totalMinor, n.currency);
  return uk
    ? `[${ctx.shopName}] Нова чернетка замовлення чекає підтвердження.\nКлієнт: ${ctx.customer}\nПозицій: ${n.itemCount}, разом ${total}`
    : `[${ctx.shopName}] A new order draft awaits approval.\nCustomer: ${ctx.customer}\nItems: ${n.itemCount}, total ${total}`;
}

export type TelegramDeps = {
  token: string;
  agent: AgentRepository;
  shops: ShopRepository;
  conversations: ConversationRepository;
  log: Logger;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
};

/**
 * One shared bot (token from the environment) posts to each shop's own chat (`shop_notify_settings`). A shop without a
 * chat id gets nothing. The token sits in the request URL as the Bot API requires, so it is never logged: failures
 * log only the shop id and a short code. One attempt per notification; the dashboard/API stays the source of truth.
 */
export class TelegramNotifier implements Notifier {
  private inflight = new Set<Promise<void>>();
  constructor(private d: TelegramDeps) {}

  notify(n: Notification): void {
    const p: Promise<void> = this.deliver(n)
      .catch((e) => this.d.log.warn({ shopId: n.shopId, code: e instanceof Error ? e.name : 'ERROR' }, 'telegram notification failed'))
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  async whenIdle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private async deliver(n: Notification): Promise<void> {
    const chatId = this.d.agent.getNotifySettings(n.shopId).telegramChatId;
    if (!chatId) return;
    const shop = this.d.shops.get(n.shopId);
    if (!shop) return;
    const conv = this.d.conversations.getConversation(n.shopId, n.conversationId);
    const customer = conv?.customer.displayName || conv?.customer.handle || '?';
    const text = renderNotification(n, { shopName: shop.name, language: shop.defaultLanguage, customer });
    const res = await (this.d.fetchImpl ?? fetch)(`${this.d.baseUrl ?? 'https://api.telegram.org'}/bot${this.d.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(this.d.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw Object.assign(new Error(`telegram ${res.status}`), { name: `TELEGRAM_${res.status}` });
  }
}
