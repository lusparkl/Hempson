import { EgressDeniedError } from './egress';

/** A call failed before or without a usable answer. Carries codes only: never a URL, token or response body. */
export class GraphError extends Error {
  constructor(
    readonly kind: 'auth' | 'rejected' | 'unavailable',
    readonly status: number | null,
    readonly graphCode: number | null,
    readonly graphSubcode: number | null = null,
  ) {
    super(`instagram api ${kind}${status ? ` (http ${status})` : ''}${graphCode ? ` (code ${graphCode})` : ''}`);
    this.name = 'GraphError';
  }
}

export type GraphConfig = {
  appId: string;
  appSecret: string;
  /** Facebook Login for Business configuration (Unified login); it defines the permissions and assets, so no `scope` is sent. */
  configId: string;
  apiVersion: string;
  graphBaseUrl: string;
  authorizeUrl: string;
  timeoutMs?: number;
};

export type SendResult =
  | { status: 'sent'; messageId: string }
  /** The request may have reached Instagram: never retry automatically. */
  | { status: 'uncertain'; code: string }
  | { status: 'failed'; code: string; authFailure: boolean };

/** One message from the Conversations API. */
export type PolledMessage = { id: string; createdAtMs: number; fromId: string; fromUsername: string | null; toId: string; text: string | null };

type Json = Record<string, unknown>;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asObj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Graph error numbers that mean the token is no longer valid (OAuthException family). */
const AUTH_CODES = new Set([190, 102, 463, 467]);
/** Rate-limit family. */
const RATE_CODES = new Set([4, 17, 32, 613]);
/** Subcodes Meta uses for "outside the allowed messaging window". Per documentation; to be confirmed by a live capture. */
const WINDOW_SUBCODES = new Set([2534022, 2018278]);

function graphErrorOf(body: unknown): { code: number | null; subcode: number | null } {
  const b = asObj(body);
  const e = asObj(b.error);
  return { code: num(e.code) ?? num(b.code), subcode: num(e.error_subcode) };
}

/**
 * Instagram API with Unified login (D23, amended by D29) over the egress `fetch`: Facebook Login for Business with a
 * `config_id`, a Business Integration System User token, everything on `graph.facebook.com`. Tokens are sent in the
 * Authorization header; the code exchange takes the app secret in the query (as documented), so URLs are never logged
 * and nothing here puts a response body into an error. Endpoint shapes are written from Meta's public documentation
 * and have not been run against Meta (see docs/LIMITATIONS.md).
 */
export class InstagramGraph {
  constructor(
    private c: GraphConfig,
    private fetchImpl: typeof fetch,
  ) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const u = new URL(this.c.authorizeUrl);
    u.searchParams.set('client_id', this.c.appId);
    u.searchParams.set('config_id', this.c.configId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    // Required by Meta for the system-user token (authorization code grant); `prompt=login` always offers both Instagram and Facebook login.
    u.searchParams.set('override_default_response_type', 'true');
    u.searchParams.set('prompt', 'login');
    u.searchParams.set('state', state);
    return u.toString();
  }

  private async call(url: string, init: RequestInit): Promise<{ status: number; ok: boolean; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.c.timeoutMs ?? 15_000) });
    } catch (e) {
      if (e instanceof EgressDeniedError) throw e;
      throw new GraphError('unavailable', null, null);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    return { status: res.status, ok: res.ok, body };
  }

  private fail(r: { status: number; body: unknown }): never {
    const { code, subcode } = graphErrorOf(r.body);
    if (r.status === 401 || (code !== null && AUTH_CODES.has(code))) throw new GraphError('auth', r.status, code, subcode);
    throw new GraphError(r.status >= 500 ? 'unavailable' : 'rejected', r.status, code, subcode);
  }

  /** Authorization code -> Business Integration System User token. Server side only: it carries the app secret. `redirect_uri` must equal the one used in the login dialog (standard OAuth; Meta's Unified-login page does not list it). */
  async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; expiresInSec: number }> {
    const q = new URLSearchParams({ client_id: this.c.appId, client_secret: this.c.appSecret, redirect_uri: redirectUri, code });
    const r = await this.call(`${this.c.graphBaseUrl}/${this.c.apiVersion}/oauth/access_token?${q}`, { method: 'GET' });
    if (!r.ok) this.fail(r);
    const b = asObj(r.body);
    if (typeof b.access_token !== 'string' || !b.access_token) throw new GraphError('rejected', r.status, null);
    // The token's lifetime is set by the configuration (default: never expires); `expires_in` is optional.
    return { accessToken: b.access_token, expiresInSec: num(b.expires_in) ?? 0 };
  }

  /** The Instagram professional accounts the business shared during login. Each `id` is the id used in webhook `entry.id` and in the Send API path. */
  async assignedAccounts(token: string): Promise<{ userId: string; username: string | null }[]> {
    const r = await this.call(`${this.c.graphBaseUrl}/${this.c.apiVersion}/me/assigned_instagram_accounts?fields=id,username`, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) this.fail(r);
    const data = asObj(r.body).data;
    const out: { userId: string; username: string | null }[] = [];
    for (const a of Array.isArray(data) ? data : []) {
      const o = asObj(a);
      if (typeof o.id === 'string' || typeof o.id === 'number') out.push({ userId: String(o.id), username: typeof o.username === 'string' ? o.username : null });
    }
    return out;
  }

  /**
   * Newest conversations with their newest messages (one call). Fallback and reconciliation path for missed webhooks:
   * Meta keeps only the latest messages per conversation, so this is a safety net, not a history.
   */
  async recentMessages(token: string, igUserId: string, conversations = 10, perConversation = 25): Promise<PolledMessage[]> {
    const fields = `updated_time,messages.limit(${perConversation}){id,created_time,from,to,message}`;
    const r = await this.call(`${this.c.graphBaseUrl}/${this.c.apiVersion}/${encodeURIComponent(igUserId)}/conversations?platform=instagram&limit=${conversations}&fields=${encodeURIComponent(fields)}`, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) this.fail(r);
    const out: PolledMessage[] = [];
    for (const c of asArr(asObj(r.body).data)) {
      for (const m of asArr(asObj(asObj(c).messages).data)) {
        const o = asObj(m);
        const from = asObj(o.from);
        const to = asObj(asArr(asObj(o.to).data)[0]);
        const id = o.id;
        const created = typeof o.created_time === 'string' ? Date.parse(o.created_time.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
        if (typeof id !== 'string' || !id || !Number.isFinite(created) || typeof from.id !== 'string' || typeof to.id !== 'string') continue;
        out.push({ id, createdAtMs: created, fromId: from.id, fromUsername: typeof from.username === 'string' ? from.username : null, toId: to.id, text: typeof o.message === 'string' ? o.message : null });
      }
    }
    return out.sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /** Subscribes the account to `messages` webhooks for this app. */
  async subscribe(token: string, igUserId: string): Promise<void> {
    const r = await this.call(`${this.c.graphBaseUrl}/${this.c.apiVersion}/${encodeURIComponent(igUserId)}/subscribed_apps?subscribed_fields=messages`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) this.fail(r);
  }

  async unsubscribe(token: string, igUserId: string): Promise<void> {
    const r = await this.call(`${this.c.graphBaseUrl}/${this.c.apiVersion}/${encodeURIComponent(igUserId)}/subscribed_apps`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) this.fail(r);
  }

  /** Customer name/username for an Instagram-scoped id. Best effort: callers ignore failures. */
  async profile(token: string, igsid: string): Promise<{ name: string | null; username: string | null }> {
    const r = await this.call(`${this.c.graphBaseUrl}/${this.c.apiVersion}/${encodeURIComponent(igsid)}?fields=name,username`, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) this.fail(r);
    const b = asObj(r.body);
    return { name: typeof b.name === 'string' ? b.name : null, username: typeof b.username === 'string' ? b.username : null };
  }

  /**
   * One attempt, no idempotency key exists. A definite rejection is `failed`; anything where the request may have been
   * processed (timeout, network error after sending, 5xx, a 2xx without a message id) is `uncertain` and never retried.
   */
  async sendText(token: string, igUserId: string, recipientId: string, text: string): Promise<SendResult> {
    let r: { status: number; ok: boolean; body: unknown };
    try {
      r = await this.call(`${this.c.graphBaseUrl}/${this.c.apiVersion}/${encodeURIComponent(igUserId)}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
      });
    } catch (e) {
      if (e instanceof EgressDeniedError) return { status: 'failed', code: 'EGRESS_DENIED', authFailure: false };
      return { status: 'uncertain', code: 'SEND_NO_RESPONSE' };
    }
    if (r.ok) {
      const id = asObj(r.body).message_id;
      return typeof id === 'string' && id ? { status: 'sent', messageId: id } : { status: 'uncertain', code: 'SEND_NO_MESSAGE_ID' };
    }
    const { code, subcode } = graphErrorOf(r.body);
    if (r.status >= 500) return { status: 'uncertain', code: `META_HTTP_${r.status}` };
    if (r.status === 401 || (code !== null && AUTH_CODES.has(code))) return { status: 'failed', code: 'TOKEN_REJECTED', authFailure: true };
    if (subcode !== null && WINDOW_SUBCODES.has(subcode)) return { status: 'failed', code: 'OUTSIDE_MESSAGING_WINDOW', authFailure: false };
    if (r.status === 429 || (code !== null && RATE_CODES.has(code))) return { status: 'failed', code: 'RATE_LIMITED_OR_BLOCKED', authFailure: false };
    return { status: 'failed', code: code !== null ? `META_${code}` : `META_HTTP_${r.status}`, authFailure: false };
  }
}
