import type { AgentRepository, ConversationRepository, ShopRepository } from '@hepson/database';

type Logger = { warn(o: object, m?: string): void };

export type Notification =
  | { kind: 'escalation'; shopId: string; conversationId: string; reason: string }
  | { kind: 'order_draft'; shopId: string; conversationId: string; draftId: string; currency: string; totalMinor: number; itemCount: number }
  /** A channel stopped working and needs the owner (for example the Instagram token was rejected). Fixed text, no provider output. */
  | { kind: 'channel_issue'; shopId: string; channel: 'instagram' | 'telegram' | 'nova_poshta'; issue: 'needs_reconnect' }
  /** An order needs a person (P4): the parcel is coming back, or the TTN could not be created (or may exist). Fixed text. */
  | { kind: 'order_update'; shopId: string; conversationId: string; draftId: string; event: 'returning' | 'ttn_failed' | 'ttn_uncertain' | 'auto_confirmed'; ttn: string | null };

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
  if (n.kind === 'channel_issue' && n.channel === 'telegram') {
    return uk
      ? `[${ctx.shopName}] Telegram-бот відключився: токен більше не діє. Підключіть бота знову в панелі, поки цього не зроблено, відповіді в Telegram не надсилаються.`
      : `[${ctx.shopName}] The Telegram bot is disconnected: its token is no longer valid. Reconnect the bot in the dashboard; no Telegram replies are sent until then.`;
  }
  if (n.kind === 'channel_issue' && n.channel === 'nova_poshta') {
    return uk
      ? `[${ctx.shopName}] Нова Пошта не приймає API-ключ. Введіть ключ знову в панелі; поки цього не зроблено, ТТН не створюються, статуси не оновлюються.`
      : `[${ctx.shopName}] Nova Poshta rejects the API key. Enter the key again in the dashboard; no TTNs are created and no statuses are updated until then.`;
  }
  if (n.kind === 'order_update') {
    const id = n.draftId.slice(0, 8);
    const ttn = n.ttn ? ` ТТН ${n.ttn}` : '';
    const ttnEn = n.ttn ? ` TTN ${n.ttn}` : '';
    const uks: Record<typeof n.event, string> = {
      returning: `Посилка${ttn} повертається (клієнт: ${ctx.customer}, замовлення ${id}). Коли вона буде у вас, позначте «Повернено» в панелі.`,
      ttn_failed: `Не вдалося створити ТТН для замовлення ${id} (клієнт: ${ctx.customer}). Перевірте дані відправника й спробуйте ще раз у панелі.`,
      ttn_uncertain: `Нова Пошта не відповіла під час створення ТТН для замовлення ${id} (клієнт: ${ctx.customer}). Перевірте кабінет НП, перш ніж пробувати знову.`,
      auto_confirmed: `ШІ-замовлення ${id} підтверджено автоматично (клієнт: ${ctx.customer}).`,
    };
    const ens: Record<typeof n.event, string> = {
      returning: `Parcel${ttnEn} is coming back (customer: ${ctx.customer}, order ${id}). Mark it "Returned" in the dashboard once it is with you.`,
      ttn_failed: `Could not create a TTN for order ${id} (customer: ${ctx.customer}). Check the sender settings and retry in the dashboard.`,
      ttn_uncertain: `Nova Poshta did not answer while creating the TTN for order ${id} (customer: ${ctx.customer}). Check the NP cabinet before retrying.`,
      auto_confirmed: `AI order ${id} was confirmed automatically (customer: ${ctx.customer}).`,
    };
    return `[${ctx.shopName}] ${uk ? uks[n.event] : ens[n.event]}`;
  }
  if (n.kind === 'channel_issue') {
    return uk
      ? `[${ctx.shopName}] Instagram відключився: токен більше не діє. Підключіть акаунт знову в панелі, поки цього не зроблено, відповіді в Instagram не надсилаються.`
      : `[${ctx.shopName}] Instagram is disconnected: the access token is no longer valid. Reconnect the account in the dashboard; no Instagram replies are sent until then.`;
  }
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
    const conv = n.kind === 'channel_issue' ? undefined : this.d.conversations.getConversation(n.shopId, n.conversationId);
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
