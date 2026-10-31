import { EgressDeniedError } from './egress';

/** A Bot API call failed. Carries codes only: never a URL (it holds the token) or Telegram's description text. */
export class TelegramApiError extends Error {
  constructor(
    readonly kind: 'auth' | 'rejected' | 'unavailable',
    readonly status: number | null,
  ) {
    super(`telegram api ${kind}${status ? ` (http ${status})` : ''}`);
    this.name = 'TelegramApiError';
  }
}

export type TelegramSendResult =
  | { status: 'sent'; messageId: number }
  /** The request may have reached Telegram: never retry automatically. */
  | { status: 'uncertain'; code: string }
  | { status: 'failed'; code: string; authFailure: boolean };

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

/** A token Telegram cannot know: 401 for a wrong token, 404 for a malformed one. */
const isAuth = (status: number) => status === 401 || status === 404;

/**
 * Telegram Bot API (D27) over the egress `fetch`. The token is part of every URL, as the Bot API requires, so URLs are
 * never logged and errors never carry one. Each call takes the token of one shop's bot; nothing here stores it.
 */
export class TelegramBotApi {
  constructor(
    private fetchImpl: typeof fetch,
    private baseUrl = 'https://api.telegram.org',
    private timeoutMs = 15_000,
  ) {}

  private async call(token: string, method: string, params: Json): Promise<{ status: number; ok: boolean; result: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof EgressDeniedError) throw e;
      throw new TelegramApiError('unavailable', null);
    }
    let body: Json = {};
    try {
      body = asObj(await res.json());
    } catch {
      /* empty or non-JSON body */
    }
    return { status: res.status, ok: res.ok && body.ok === true, result: body.result };
  }

  private fail(r: { status: number }): never {
    if (isAuth(r.status)) throw new TelegramApiError('auth', r.status);
    throw new TelegramApiError(r.status >= 500 || r.status === 429 ? 'unavailable' : 'rejected', r.status);
  }

  /** The bot behind a token. */
  async getMe(token: string): Promise<{ id: string; username: string | null }> {
    const r = await this.call(token, 'getMe', {});
    if (!r.ok) this.fail(r);
    const b = asObj(r.result);
    if (typeof b.id !== 'number' || !Number.isSafeInteger(b.id) || b.is_bot !== true) throw new TelegramApiError('rejected', r.status);
    return { id: String(b.id), username: typeof b.username === 'string' ? b.username : null };
  }

  /** Points the bot at Hepson. Only private-chat messages are requested; updates queued before connecting are dropped (no history import). */
  async setWebhook(token: string, url: string, secret: string): Promise<void> {
    const r = await this.call(token, 'setWebhook', { url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true });
    if (!r.ok || r.result !== true) this.fail(r);
  }

  async deleteWebhook(token: string): Promise<void> {
    const r = await this.call(token, 'deleteWebhook', {});
    if (!r.ok) this.fail(r);
  }

  /**
   * One attempt, no idempotency key exists. A definite rejection is `failed`; anything where the request may have been
   * processed (timeout, network error after sending, 5xx, a 2xx without a message id) is `uncertain` and never retried.
   */
  async sendMessage(token: string, chatId: string, text: string): Promise<TelegramSendResult> {
    let r: { status: number; ok: boolean; result: unknown };
    try {
      // Plain text: no parse mode, so model or customer text cannot inject markup or link previews.
      r = await this.call(token, 'sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
    } catch (e) {
      if (e instanceof EgressDeniedError) return { status: 'failed', code: 'EGRESS_DENIED', authFailure: false };
      return { status: 'uncertain', code: 'SEND_NO_RESPONSE' };
    }
    if (r.ok) {
      const id = asObj(r.result).message_id;
      return typeof id === 'number' && Number.isSafeInteger(id) ? { status: 'sent', messageId: id } : { status: 'uncertain', code: 'SEND_NO_MESSAGE_ID' };
    }
    if (r.status >= 500) return { status: 'uncertain', code: `TELEGRAM_HTTP_${r.status}` };
    if (isAuth(r.status)) return { status: 'failed', code: 'TOKEN_REJECTED', authFailure: true };
    // 403: the customer blocked the bot or deleted the account. Recorded as failed (D27).
    if (r.status === 403) return { status: 'failed', code: 'BOT_BLOCKED', authFailure: false };
    if (r.status === 429) return { status: 'failed', code: 'RATE_LIMITED', authFailure: false };
    return { status: 'failed', code: `TELEGRAM_HTTP_${r.status}`, authFailure: false };
  }
}
