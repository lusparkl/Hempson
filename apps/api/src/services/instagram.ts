import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConnectorError } from '@hepson/connector-core';
import {
  ConversationValidationError,
  CredentialDecryptError,
  CredentialMissingError,
  CredentialsUnavailableError,
  INSTAGRAM_CHANNEL,
  InstagramAccountTakenError,
  type ConversationRepository,
  type CredentialVault,
  type InstagramChannelRow,
  type InstagramRepository,
} from '@hepson/database';
import { GraphError, type InstagramGraph } from './instagram-graph';
import type { Notifier } from './notifier';

type Logger = { info(o: object, m?: string): void; warn(o: object, m?: string): void };

/** Instagram lets a business reply for 24 hours after the customer's last message. */
export const MESSAGING_WINDOW_MS = 24 * 3_600_000;
const STATE_TTL_MS = 10 * 60_000;

/** `X-Hub-Signature-256` check: HMAC-SHA256 of the raw body with the app secret, constant time. Parse the body only after this passes. */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  const m = header && /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const want = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(want, Buffer.from(m[1]!, 'hex'));
}

/** The business shared no account, or several, during login: one shop connects exactly one. */
export class InstagramAccountSelectionError extends Error {
  constructor(readonly shared: number) {
    super(shared === 0 ? 'no Instagram professional account was shared' : 'more than one Instagram account was shared');
    this.name = 'InstagramAccountSelectionError';
  }
}

export type InstagramSendOutcome = { status: 'sent'; externalId: string } | { status: 'uncertain'; code: string } | { status: 'failed'; code: string };

export type InstagramServiceDeps = {
  graph: InstagramGraph;
  vault: CredentialVault;
  repo: InstagramRepository;
  conversations: ConversationRepository;
  log: Logger;
  /** Public base URL; the OAuth redirect URI is `<publicUrl>/public/instagram/callback`. */
  publicUrl: string;
  appConfigured: boolean;
  /** Called once per genuinely new inbound customer message. */
  onInbound: (shopId: string, conversationId: string, messageId: string) => void;
  notifier?: Notifier;
  clock?: () => Date;
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function eventTime(ts: unknown, now: Date): string {
  let ms = typeof ts === 'number' && Number.isFinite(ts) ? ts : NaN;
  if (ms > 0 && ms < 1e12) ms *= 1000; // seconds
  return new Date(Number.isFinite(ms) && ms > 0 ? Math.min(ms, now.getTime()) : now.getTime()).toISOString();
}

/**
 * The official Instagram channel (D23): connect flow, webhook ingest, sends and token upkeep. Writes straight into the
 * shop tables (like the website chat, D19); it does not use the Phase 1 connector layer.
 */
export class InstagramService {
  private inflight = new Set<Promise<unknown>>();
  private profileTried = new Set<string>();
  private connectingAccounts = new Set<string>();
  private connectionOperations = new Map<string, { kind: 'connect' | 'disconnect' }>();
  private connectionVersion = 0;
  constructor(private d: InstagramServiceDeps) {}

  private now() {
    return (this.d.clock ?? (() => new Date()))();
  }

  /** The operator configured the Meta app and the master key: connect, webhook and sends are possible. */
  get enabled(): boolean {
    return this.d.appConfigured && this.d.vault.available;
  }
  get redirectUri(): string {
    return `${this.d.publicUrl}/public/instagram/callback`;
  }
  async whenIdle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }
  private track<T>(p: Promise<T>): void {
    const q: Promise<unknown> = p.catch(() => undefined).finally(() => this.inflight.delete(q));
    this.inflight.add(q);
  }

  // ---------- connect ----------

  /** Non-secret state for the dashboard. */
  status(shopId: string) {
    const ch = this.d.repo.getChannel(shopId);
    return {
      available: this.enabled,
      redirectUri: this.redirectUri,
      status: ch ? ch.status : ('not_connected' as const),
      username: ch?.username ?? null,
      tokenExpiresAt: ch?.tokenExpiresAt ?? null,
      lastError: ch?.lastError ?? null,
      connectedAt: ch?.connectedAt ?? null,
    };
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new ConnectorError('NOT_CONFIGURED', 'Instagram connection is not configured on this server');
  }

  startConnect(shopId: string, userId: string): { authorizeUrl: string } {
    this.requireEnabled();
    return { authorizeUrl: this.d.graph.authorizeUrl(this.d.repo.createState(shopId, userId, STATE_TTL_MS), this.redirectUri) };
  }

  /** Callback: validates the single-use `state`, exchanges the code, stores the token encrypted and links the shared account. */
  async completeConnect(code: string, state: string): Promise<{ shopId: string }> {
    this.requireEnabled();
    const st = this.d.repo.consumeState(state);
    if (!st) throw new ConnectorError('FORBIDDEN', 'Connect link expired or already used');
    const { graph, vault, repo, log } = this.d;
    if (this.connectionOperations.has(st.shopId)) throw new ConnectorError('TEMPORARY_FAILURE', 'Instagram connection is already in progress');
    const operation = { kind: 'connect' as const };
    this.connectionOperations.set(st.shopId, operation);
    const requireCurrent = () => {
      if (this.connectionOperations.get(st.shopId) !== operation) throw new ConnectorError('TEMPORARY_FAILURE', 'Instagram connection was canceled');
    };
    let step = 'exchange_code';
    try {
      const tok = await graph.exchangeCode(code, this.redirectUri);
      requireCurrent();
      step = 'assigned_accounts';
      const accounts = await graph.assignedAccounts(tok.accessToken);
      requireCurrent();
      // One shop = one account. Never guess which of several to use.
      if (accounts.length !== 1) throw new InstagramAccountSelectionError(accounts.length);
      const me = accounts[0]!;
      const existing = repo.findByIgUserId(me.userId);
      if (existing && existing.shopId !== st.shopId) throw new InstagramAccountTakenError();
      const expiresAt = tok.expiresInSec > 0 ? new Date(this.now().getTime() + tok.expiresInSec * 1000).toISOString() : null;
      step = 'subscribe';
      if (this.connectingAccounts.has(me.userId)) throw new ConnectorError('TEMPORARY_FAILURE', 'Instagram connection is already in progress');
      this.connectingAccounts.add(me.userId);
      try {
        await graph.subscribe(tok.accessToken, me.userId);
        requireCurrent();
        // A connection is usable only after Meta confirms the subscription. Preserve an existing connection on failure.
        // Save both rows atomically: an account claimed while subscription was in flight must not replace its token.
        repo.db.transaction(() => {
          repo.upsertChannel(st.shopId, { igUserId: me.userId, username: me.username, tokenExpiresAt: expiresAt });
          vault.save(st.shopId, 'instagram', tok.accessToken);
        });
        this.connectionVersion++;
      } finally {
        // A canceled attempt may already be subscribed remotely. Keep the account reserved until cleanup finishes.
        if (this.connectionOperations.get(st.shopId) !== operation) {
          await graph
            .unsubscribe(tok.accessToken, me.userId)
            .catch((e) => log.warn({ shopId: st.shopId, code: e instanceof GraphError ? e.graphCode : null }, 'instagram canceled connection unsubscribe failed'));
        }
        this.connectingAccounts.delete(me.userId);
      }
      return { shopId: st.shopId };
    } catch (e) {
      if (e instanceof InstagramAccountTakenError) throw new ConnectorError('VALIDATION_ERROR', e.message);
      if (e instanceof GraphError) {
        log.warn({ shopId: st.shopId, step, kind: e.kind, status: e.status, graphCode: e.graphCode, graphSubcode: e.graphSubcode }, 'instagram connect: graph call failed');
        throw new ConnectorError(e.kind === 'unavailable' ? 'TEMPORARY_FAILURE' : 'LOGIN_REQUIRED', 'Instagram did not accept the connection');
      }
      throw e;
    } finally {
      if (this.connectionOperations.get(st.shopId) === operation) this.connectionOperations.delete(st.shopId);
    }
  }

  async disconnect(shopId: string): Promise<void> {
    if (this.connectionOperations.get(shopId)?.kind === 'disconnect') throw new ConnectorError('TEMPORARY_FAILURE', 'Instagram disconnection is already in progress');
    // Replacing the identity cancels a pending callback before any asynchronous unsubscribe work begins.
    const operation = { kind: 'disconnect' as const };
    this.connectionOperations.set(shopId, operation);
    try {
      const ch = this.d.repo.getChannel(shopId);
      if (ch && this.d.vault.available) {
        await this.d.vault
          .withSecret(shopId, 'instagram', (t) => this.d.graph.unsubscribe(t, ch.igUserId))
          .catch((e) => this.d.log.warn({ shopId, code: e instanceof GraphError ? e.graphCode : null }, 'instagram unsubscribe failed'));
      }
      if (this.d.vault.available) this.d.vault.delete(shopId, 'instagram');
      this.d.repo.deleteChannel(shopId);
      this.connectionVersion++;
    } finally {
      if (this.connectionOperations.get(shopId) === operation) this.connectionOperations.delete(shopId);
    }
  }

  private markNeedsReconnect(shopId: string, code: string): void {
    this.d.vault.mark(shopId, 'instagram', 'needs_reconnect');
    if (this.d.repo.setNeedsReconnect(shopId, code)) {
      this.connectionVersion++;
      this.d.log.warn({ shopId, code }, 'instagram needs reconnect');
      this.d.notifier?.notify({ kind: 'channel_issue', shopId, channel: 'instagram', issue: 'needs_reconnect' });
    }
  }

  // ---------- inbound ----------

  /** Ingests an already signature-checked webhook payload. One bad event never blocks the others. Returns how many new customer messages were stored. */
  handleWebhook(payload: unknown): number {
    const root = obj(payload);
    if (root.object !== 'instagram' || !Array.isArray(root.entry)) {
      this.d.log.info({ object: typeof root.object === 'string' ? root.object : null }, 'instagram webhook ignored: unexpected shape');
      return 0;
    }
    let stored = 0;
    let retryableFailure = false;
    for (const e of root.entry) {
      const entry = obj(e);
      const igId = str(entry.id);
      const ch = igId && this.d.repo.findByIgUserId(igId);
      // Two envelopes are documented: `messaging[]` (Instagram messaging) and `changes[]` of `{field:'messages', value:<event>}` (webhook fields / dashboard test).
      const changes = Array.isArray(entry.changes) ? entry.changes.map(obj) : [];
      const messaging = [...(Array.isArray(entry.messaging) ? entry.messaging : []), ...changes.filter((c) => c.field === 'messages').map((c) => c.value)];
      // Shape only: ids of our own account, counts and field names. Never message text or customer ids.
      this.d.log.info({ entryId: igId ?? null, matched: !!ch, events: messaging.length, keys: Object.keys(entry).filter((k) => k !== 'id' && k !== 'time'), fields: changes.map((c) => str(c.field) ?? null) }, 'instagram webhook entry');
      if (!ch) {
        // Meta can start delivery before the subscribe response returns and the channel is saved. Ask it to retry.
        if (igId && this.connectingAccounts.has(igId)) retryableFailure = true;
        continue; // unknown account: acknowledged, dropped
      }
      for (const ev of messaging) {
        try {
          if (this.ingestEvent(ch, obj(ev))) stored++;
        } catch (err) {
          const retryable = !(err instanceof ConversationValidationError);
          retryableFailure ||= retryable;
          this.d.log.warn({ shopId: ch.shopId, err: err instanceof Error ? err.name : 'ERROR', retryable }, 'instagram event skipped');
        }
      }
    }
    if (retryableFailure) throw new ConnectorError('TEMPORARY_FAILURE', 'Instagram webhook processing failed; retry delivery');
    return stored;
  }

  /** @returns true when a new inbound customer message was stored. */
  private ingestEvent(ch: InstagramChannelRow, ev: Json): boolean {
    const m = obj(ev.message);
    const mid = str(m.mid);
    if (!mid || m.is_deleted === true) return false;
    const sender = str(obj(ev.sender).id);
    const recipient = str(obj(ev.recipient).id);
    const echo = m.is_echo === true || sender === ch.igUserId;
    const customerId = echo ? recipient : sender;
    if (!customerId || customerId === ch.igUserId) return false;
    const text = str(m.text) ?? null;
    const attachments = (Array.isArray(m.attachments) ? m.attachments : []).map((a) => {
      const t = str(obj(a).type);
      return { kind: t === 'image' || t === 'video' || t === 'audio' ? t : 'other' };
    });
    if (!text && !attachments.length) return false;
    const occurredAt = eventTime(ev.timestamp, this.now());
    const { conversations } = this.d;

    if (echo) {
      // Sent from this account: by Hepson (adopt our pending row) or by a person in the Instagram app (record as human).
      const { conversation } = conversations.ensureConversation(ch.shopId, { channel: INSTAGRAM_CHANNEL, conversationExternalId: customerId, customer: { externalId: customerId } });
      if (text && conversations.adoptPendingOutbound(ch.shopId, conversation.id, text, mid, 'sent', 'ai')) return false;
      if (text && conversations.adoptPendingOutbound(ch.shopId, conversation.id, text, mid, 'sent', 'human')) return false;
      conversations.recordOutbound(ch.shopId, conversation.id, { senderType: 'human', text, attachments, externalId: mid, deliveryStatus: 'sent', occurredAt });
      return false;
    }

    // Dispatch reads the newly stored message synchronously and queues its work for after this transaction commits.
    // If dispatch throws, roll the insert back so a retried delivery can still trigger the agent exactly once.
    const r = conversations.db.transaction(() => {
      const incoming = conversations.ingestMessage(ch.shopId, { channel: INSTAGRAM_CHANNEL, conversationExternalId: customerId, customer: { externalId: customerId }, externalId: mid, text, attachments, occurredAt });
      if (!incoming.duplicated) {
        try {
          this.d.onInbound(ch.shopId, incoming.conversation.id, incoming.message.id);
        } catch {
          throw new ConnectorError('TEMPORARY_FAILURE', 'Instagram inbound dispatch failed');
        }
      }
      return incoming;
    });
    if (r.duplicated) return false;
    if (!r.customer.displayName && !r.customer.handle) this.track(this.enrichProfile(ch.shopId, customerId));
    return true;
  }

  private async enrichProfile(shopId: string, igsid: string): Promise<void> {
    const key = `${shopId}:${igsid}`;
    if (this.profileTried.has(key)) return;
    this.profileTried.add(key);
    try {
      const p = await this.d.vault.withSecret(shopId, 'instagram', (t) => this.d.graph.profile(t, igsid));
      if (!p.name && !p.username) return;
      this.d.conversations.ensureConversation(shopId, { channel: INSTAGRAM_CHANNEL, conversationExternalId: igsid, customer: { externalId: igsid, displayName: p.name ?? p.username, handle: p.username } });
    } catch {
      /* profile data is optional */
    }
  }

  // ---------- outbound ----------

  /** Why a reply cannot be sent right now, or null. Checked before anything is recorded or called. */
  blockReason(shopId: string, conversationId: string): 'ACCOUNT_NOT_CONNECTED' | 'OUTSIDE_MESSAGING_WINDOW' | null {
    const ch = this.d.repo.getChannel(shopId);
    if (!this.enabled || !ch || ch.status !== 'connected') return 'ACCOUNT_NOT_CONNECTED';
    const last = this.d.conversations.lastInboundAt(shopId, conversationId);
    if (!last || this.now().getTime() - Date.parse(last) > MESSAGING_WINDOW_MS) return 'OUTSIDE_MESSAGING_WINDOW';
    return null;
  }

  /** True when this shop has a connected channel (used to route replies). */
  isConnected(shopId: string): boolean {
    return this.d.repo.getChannel(shopId)?.status === 'connected';
  }

  /** Sends one text to the conversation's customer. Never retries; never throws for provider problems. */
  async send(shopId: string, conversationId: string, text: string): Promise<InstagramSendOutcome> {
    const blocked = this.blockReason(shopId, conversationId);
    if (blocked) return { status: 'failed', code: blocked };
    const ch = this.d.repo.getChannel(shopId)!;
    const conv = this.d.conversations.getConversation(shopId, conversationId);
    if (!conv || conv.conversation.channel !== INSTAGRAM_CHANNEL) return { status: 'failed', code: 'ACCOUNT_NOT_CONNECTED' };
    try {
      const r = await this.d.vault.withSecret(shopId, 'instagram', (t) => this.d.graph.sendText(t, ch.igUserId, conv.conversation.externalId, text));
      if (r.status === 'sent') return { status: 'sent', externalId: r.messageId };
      if (r.status === 'uncertain') return { status: 'uncertain', code: r.code };
      if (r.authFailure) this.markNeedsReconnect(shopId, r.code);
      return { status: 'failed', code: r.code };
    } catch (e) {
      if (e instanceof CredentialMissingError) return { status: 'failed', code: 'ACCOUNT_NOT_CONNECTED' };
      if (e instanceof CredentialDecryptError || e instanceof CredentialsUnavailableError) return { status: 'failed', code: 'CREDENTIAL_ERROR' };
      throw e;
    }
  }

  // ---------- polling (fallback / reconciliation) ----------

  private polling = false;

  /**
   * Reads recent messages through the Conversations API and feeds the same ingest as the webhook. A safety net for
   * missed or undelivered webhooks, off unless configured. The first run starts at connection time (no history import).
   * Message ids from this API are assumed to equal webhook `mid`s; if they did not, running both paths would store
   * a message twice (unverified, see D29).
   * @returns how many new customer messages were stored.
   */
  async pollOnce(): Promise<number> {
    if (this.polling || !this.enabled) return 0;
    this.polling = true;
    let stored = 0;
    try {
      for (const { shopId } of this.d.repo.listConnected()) {
        const ch = this.d.repo.getChannel(shopId);
        if (!ch || ch.status !== 'connected') continue;
        const connectionVersion = this.connectionVersion;
        try {
          const since = Date.parse(ch.polledUntil ?? ch.connectedAt);
          const msgs = await this.d.vault.withSecret(ch.shopId, 'instagram', (t) => this.d.graph.recentMessages(t, ch.igUserId));
          // A connection changed while Graph was pending. Leave its cursor untouched and poll current state next time.
          if (connectionVersion !== this.connectionVersion) continue;
          let newest = since;
          let retryableFailure = false;
          let shopStored = 0;
          for (const m of msgs) {
            // A later poll may reveal another message with the same timestamp. Message ids deduplicate repeats.
            if (m.createdAtMs < since) continue;
            newest = Math.max(newest, m.createdAtMs);
            const own = m.fromId === ch.igUserId || (!!ch.username && m.fromUsername === ch.username);
            try {
              const ev = { sender: { id: own ? ch.igUserId : m.fromId }, recipient: { id: own ? m.toId : ch.igUserId }, timestamp: m.createdAtMs, message: { mid: m.id, text: m.text ?? undefined, is_echo: own } };
              if (this.ingestEvent(ch, ev)) {
                stored++;
                shopStored++;
              }
            } catch (err) {
              const retryable = !(err instanceof ConversationValidationError);
              retryableFailure ||= retryable;
              this.d.log.warn({ shopId: ch.shopId, err: err instanceof Error ? err.name : 'ERROR', retryable }, 'instagram polled message skipped');
            }
          }
          // Keep the batch available for retry when storage or dispatch failed; successful messages are idempotent.
          if (!retryableFailure && (!ch.polledUntil || newest > since)) this.d.repo.setPolledUntil(ch.shopId, new Date(newest).toISOString());
          if (newest > since || shopStored) this.d.log.info({ shopId: ch.shopId, fetched: msgs.length, stored: shopStored }, 'instagram poll');
        } catch (e) {
          if (connectionVersion !== this.connectionVersion) continue;
          if (e instanceof GraphError && e.kind === 'auth') this.markNeedsReconnect(ch.shopId, 'TOKEN_REJECTED');
          else this.d.log.warn({ shopId: ch.shopId, code: e instanceof GraphError ? e.graphCode : e instanceof Error ? e.name : 'ERROR' }, 'instagram poll failed');
        }
      }
    } finally {
      this.polling = false;
    }
    await this.whenIdle();
    return stored;
  }

  // ---------- token upkeep ----------

  /**
   * The Unified-login token has no refresh call: its lifetime comes from the Meta configuration (default: never expires)
   * and Meta may report `expires_in`. A token known to be expired needs a reconnect; a revoked one is caught on the next send.
   */
  async expireDue(): Promise<void> {
    for (const ch of this.d.repo.listConnected()) {
      if (ch.tokenExpiresAt && Date.parse(ch.tokenExpiresAt) <= this.now().getTime()) this.markNeedsReconnect(ch.shopId, 'TOKEN_EXPIRED');
    }
  }
}
