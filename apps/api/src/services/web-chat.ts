import { randomUUID } from 'node:crypto';
import { ConnectorError } from '@hepson/connector-core';
import { WEB_CHANNEL, type ConversationRepository, type ShopMessageRow, type WebChatConfigRow, type WebChatRepository, type WebChatSessionRow } from '@hepson/database';
import { RateLimiter } from './rate-limit';

/** 429 that tells the client how long to wait (sent as `Retry-After`). */
export class RateLimitedError extends ConnectorError {
  constructor(readonly retryAfterSec: number) {
    super('RATE_LIMITED_OR_BLOCKED', 'Too many requests, try again later');
  }
}

export type WebChatLimits = {
  sessionsPerIpPerHour: number;
  messagesPerSessionPerMinute: number;
  messagesPerIpPerMinute: number;
  /** Visitor messages per shop per UTC day (also caps AI cost). */
  dailyMessagesPerShop: number;
  sessionTtlMs: number;
  maxMessageLength: number;
};

/** What a visitor may see of a message: no user ids, no delivery internals, and whether a reply came from the AI. */
export const visitorView = (m: ShopMessageRow) => ({
  messageId: m.id,
  seq: m.seq,
  from: m.direction === 'incoming' ? ('visitor' as const) : ('shop' as const),
  fromAi: m.senderType === 'ai',
  text: m.text ?? '',
  createdAt: m.occurredAt,
});

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();

/**
 * The visitor side of the website chat (Feature 10). Authorization is layered: the widget key picks the shop, the
 * `Origin` must be on the shop's allow-list, and every message needs the visitor's own session token. Abuse limits:
 * sessions per IP, messages per session and per IP, and a per-shop daily cap. All failures are generic and carry no shop data.
 */
export class WebChatService {
  private sessionsPerIp: RateLimiter;
  private msgPerSession: RateLimiter;
  private msgPerIp: RateLimiter;

  constructor(
    private repo: WebChatRepository,
    private conversations: ConversationRepository,
    private limits: WebChatLimits,
    private onInbound: (shopId: string, conversationId: string, messageId: string) => void,
    private clock: () => Date = () => new Date(),
  ) {
    this.sessionsPerIp = new RateLimiter(limits.sessionsPerIpPerHour, 3_600_000);
    this.msgPerSession = new RateLimiter(limits.messagesPerSessionPerMinute, 60_000);
    this.msgPerIp = new RateLimiter(limits.messagesPerIpPerMinute, 60_000);
  }

  /** The enabled config for a widget key, or null. Disabled and unknown keys look the same. */
  config(widgetKey: string): WebChatConfigRow | null {
    const c = this.repo.findByKey(widgetKey);
    return c?.enabled ? c : null;
  }

  /** True when the request's Origin is exactly one of the shop's allowed origins. A missing Origin is refused. */
  originAllowed(cfg: WebChatConfigRow, origin: string | undefined): boolean {
    return !!origin && cfg.allowedOrigins.includes(origin.toLowerCase());
  }

  private tooMany(retryAfter: number): never {
    throw new RateLimitedError(retryAfter);
  }

  openSession(cfg: WebChatConfigRow, ip: string, displayName?: string | null): { token: string; expiresAt: string } {
    const wait = this.sessionsPerIp.hit(ip);
    if (wait) this.tooMany(wait);
    const { session, token } = this.repo.createSession(cfg.shopId, { displayName }, this.limits.sessionTtlMs);
    return { token, expiresAt: session.expiresAt };
  }

  session(cfg: WebChatConfigRow, token: string | undefined): WebChatSessionRow {
    const s = token ? this.repo.findSession(cfg.shopId, token) : undefined;
    if (!s) throw new ConnectorError('UNAUTHORIZED', 'Chat session missing or expired');
    return s;
  }

  send(cfg: WebChatConfigRow, s: WebChatSessionRow, ip: string, text: string): ShopMessageRow {
    const wait = this.msgPerSession.hit(s.id) || this.msgPerIp.hit(ip);
    if (wait) this.tooMany(wait);
    if (this.repo.countInboundSince(cfg.shopId, startOfUtcDay(this.clock())) >= this.limits.dailyMessagesPerShop) this.tooMany(3600);
    const r = this.conversations.ingestMessage(cfg.shopId, {
      channel: WEB_CHANNEL,
      conversationExternalId: s.visitorId,
      customer: { externalId: s.visitorId, displayName: s.displayName ?? `Відвідувач ${s.visitorId.slice(0, 4)}` },
      externalId: `v:${randomUUID()}`,
      text,
    });
    this.repo.touchSession(s.id);
    this.onInbound(cfg.shopId, r.conversation.id, r.message.id);
    return r.message;
  }

  /** Messages the visitor may see (own and replies that were actually delivered), after `afterSeq`. */
  messages(cfg: WebChatConfigRow, s: WebChatSessionRow, afterSeq: number): ShopMessageRow[] {
    this.repo.touchSession(s.id);
    const conv = this.conversations.findConversationByExternal(cfg.shopId, WEB_CHANNEL, s.visitorId);
    if (!conv) return [];
    return this.conversations
      .listMessages(cfg.shopId, conv.conversation.id, { limit: 200 })
      .items.filter((m) => m.seq > afterSeq && (m.direction === 'incoming' || m.deliveryStatus === 'sent'));
  }
}
