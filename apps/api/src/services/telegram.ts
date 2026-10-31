import { randomBytes } from 'node:crypto';
import { ConnectorError } from '@hepson/connector-core';
import {
  ConversationValidationError,
  CredentialDecryptError,
  CredentialMissingError,
  CredentialsUnavailableError,
  TELEGRAM_CHANNEL,
  TelegramBotTakenError,
  type ConversationRepository,
  type CredentialVault,
  type TelegramChannelRow,
  type TelegramRepository,
} from '@hepson/database';
import type { Notifier } from './notifier';
import { TelegramApiError, type TelegramBotApi } from './telegram-bot';

type Logger = { info(o: object, m?: string): void; warn(o: object, m?: string): void };

/** BotFather token shape: `<bot id>:<secret>`. Checked before any call so a pasted wrong value never reaches Telegram. */
const TOKEN_RE = /^\d{3,20}:[A-Za-z0-9_-]{30,100}$/;
/** Characters Telegram allows in `secret_token` (1-256). */
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

export type TelegramSendOutcome = { status: 'sent'; externalId: string } | { status: 'uncertain'; code: string } | { status: 'failed'; code: string };

export type TelegramServiceDeps = {
  api: TelegramBotApi;
  vault: CredentialVault;
  repo: TelegramRepository;
  conversations: ConversationRepository;
  log: Logger;
  /** Public base URL; the webhook is `<publicUrl>/webhooks/telegram/<webhookId>`. Telegram accepts https only. */
  publicUrl: string;
  /** Called once per genuinely new inbound customer message. */
  onInbound: (shopId: string, conversationId: string, messageId: string) => void;
  notifier?: Notifier;
  clock?: () => Date;
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
const intId = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : undefined);

function attachmentsOf(m: Json): { kind: string }[] {
  const out: { kind: string }[] = [];
  if (Array.isArray(m.photo) && m.photo.length) out.push({ kind: 'image' });
  if (m.video || m.video_note || m.animation) out.push({ kind: 'video' });
  if (m.voice || m.audio) out.push({ kind: 'audio' });
  if (m.document || m.sticker || m.location || m.contact) out.push({ kind: 'other' });
  return out;
}

/**
 * The Telegram customer channel (D27): one bot per shop, token in the credential vault (D28). Inbound by webhook with a
 * per-shop secret header; writes straight into the shop tables like Instagram and website chat. No messaging window.
 */
export class TelegramService {
  private operations = new Set<string>();
  private connectingBots = new Set<string>();
  constructor(private d: TelegramServiceDeps) {}

  private now() {
    return (this.d.clock ?? (() => new Date()))();
  }

  /** The master key is set and the public URL is https (Telegram refuses other webhook URLs). */
  get enabled(): boolean {
    return this.d.vault.available && this.d.publicUrl.startsWith('https://');
  }
  private webhookUrl(webhookId: string): string {
    return `${this.d.publicUrl}/webhooks/telegram/${webhookId}`;
  }
  private requireEnabled(): void {
    if (!this.enabled) throw new ConnectorError('NOT_CONFIGURED', 'Telegram connection is not configured on this server');
  }

  /** Non-secret state for the dashboard. */
  status(shopId: string) {
    const ch = this.d.repo.getChannel(shopId);
    return {
      available: this.enabled,
      status: ch ? ch.status : ('not_connected' as const),
      botUsername: ch?.botUsername ?? null,
      lastError: ch?.lastError ?? null,
      connectedAt: ch?.connectedAt ?? null,
    };
  }

  // ---------- connect ----------

  /** Checks the owner's bot token, registers the webhook with a fresh secret, then stores the token encrypted. */
  async connect(shopId: string, token: string): Promise<ReturnType<TelegramService['status']>> {
    this.requireEnabled();
    if (!TOKEN_RE.test(token)) throw new ConnectorError('VALIDATION_ERROR', 'This is not a Telegram bot token');
    if (this.operations.has(shopId)) throw new ConnectorError('TEMPORARY_FAILURE', 'Telegram connection is already in progress');
    this.operations.add(shopId);
    const { api, vault, repo, log } = this.d;
    let step = 'get_me';
    let botId: string | undefined;
    try {
      const me = await api.getMe(token);
      const owner = repo.findByBotId(me.id);
      if (owner && owner.shopId !== shopId) throw new TelegramBotTakenError();
      if (this.connectingBots.has(me.id)) throw new ConnectorError('TEMPORARY_FAILURE', 'Telegram connection is already in progress');
      botId = me.id;
      this.connectingBots.add(me.id);
      const webhookId = randomBytes(24).toString('base64url');
      const secret = randomBytes(32).toString('base64url');
      step = 'set_webhook';
      await api.setWebhook(token, this.webhookUrl(webhookId), secret);
      // A different bot was connected before: stop it delivering to this shop. Best effort, its token is replaced next.
      const old = repo.getChannel(shopId);
      if (old && old.botId !== me.id) await this.dropWebhook(shopId);
      repo.db.transaction(() => {
        repo.upsertChannel(shopId, { botId: me.id, botUsername: me.username, webhookId, secret });
        vault.save(shopId, 'telegram_bot', token);
      });
      log.info({ shopId }, 'telegram connected');
      return this.status(shopId);
    } catch (e) {
      if (e instanceof TelegramBotTakenError) throw new ConnectorError('VALIDATION_ERROR', e.message);
      if (e instanceof TelegramApiError) {
        log.warn({ shopId, step, kind: e.kind, status: e.status }, 'telegram connect: bot api call failed');
        if (e.kind === 'unavailable') throw new ConnectorError('TEMPORARY_FAILURE', 'Telegram is not reachable, try again');
        throw new ConnectorError('VALIDATION_ERROR', 'Telegram did not accept this bot token');
      }
      throw e;
    } finally {
      if (botId) this.connectingBots.delete(botId);
      this.operations.delete(shopId);
    }
  }

  private async dropWebhook(shopId: string): Promise<void> {
    if (!this.d.vault.available) return;
    await this.d.vault
      .withSecret(shopId, 'telegram_bot', (t) => this.d.api.deleteWebhook(t))
      .catch((e) => this.d.log.warn({ shopId, code: e instanceof TelegramApiError ? e.status : e instanceof Error ? e.name : 'ERROR' }, 'telegram deleteWebhook failed'));
  }

  /** Removes the webhook (best effort), the stored token and the channel. */
  async disconnect(shopId: string): Promise<void> {
    if (this.operations.has(shopId)) throw new ConnectorError('TEMPORARY_FAILURE', 'Telegram connection is already in progress');
    this.operations.add(shopId);
    try {
      if (this.d.repo.getChannel(shopId)) await this.dropWebhook(shopId);
      if (this.d.vault.available) this.d.vault.delete(shopId, 'telegram_bot');
      this.d.repo.deleteChannel(shopId);
    } finally {
      this.operations.delete(shopId);
    }
  }

  private markNeedsReconnect(shopId: string, code: string): void {
    this.d.vault.mark(shopId, 'telegram_bot', 'needs_reconnect');
    if (this.d.repo.setNeedsReconnect(shopId, code)) {
      this.d.log.warn({ shopId, code }, 'telegram needs reconnect');
      this.d.notifier?.notify({ kind: 'channel_issue', shopId, channel: 'telegram', issue: 'needs_reconnect' });
    }
  }

  // ---------- inbound ----------

  /**
   * One webhook delivery. Unknown paths and wrong secrets get the same answer (no oracle for which paths exist).
   * Throws a retryable error when storing failed, so Telegram delivers the update again.
   * @returns true when a new inbound customer message was stored.
   */
  handleUpdate(webhookId: string, secret: string | undefined, payload: unknown): boolean {
    const ch = this.d.repo.findByWebhookId(webhookId);
    if (!ch || !secret || !SECRET_RE.test(secret) || !this.d.repo.secretMatches(ch, secret)) throw new ConnectorError('UNAUTHORIZED', 'Invalid webhook secret');
    try {
      return this.ingest(ch, obj(payload));
    } catch (err) {
      if (err instanceof ConversationValidationError) {
        this.d.log.warn({ shopId: ch.shopId, err: err.name }, 'telegram update skipped');
        return false;
      }
      this.d.log.warn({ shopId: ch.shopId, err: err instanceof Error ? err.name : 'ERROR' }, 'telegram update failed');
      throw new ConnectorError('TEMPORARY_FAILURE', 'Telegram update processing failed; retry delivery');
    }
  }

  private ingest(ch: TelegramChannelRow, update: Json): boolean {
    // Only private chats with people; groups, channels, edits and service messages are acknowledged and dropped.
    // Replayed updates carry the same message, and `<chat_id>:<message_id>` is unique per shop, so storage dedupes them.
    const m = obj(update.message);
    const chat = obj(m.chat);
    const from = obj(m.from);
    const chatId = intId(chat.id);
    const messageId = intId(m.message_id);
    if (chat.type !== 'private' || !chatId || !messageId || from.is_bot === true) return false;
    const text = str(m.text) ?? str(m.caption) ?? null;
    const attachments = attachmentsOf(m);
    if (!text && !attachments.length) return false;
    const name = [str(from.first_name), str(from.last_name)].filter(Boolean).join(' ').slice(0, 200) || undefined;
    const sec = typeof m.date === 'number' && Number.isFinite(m.date) && m.date > 0 ? m.date * 1000 : NaN;
    const occurredAt = new Date(Number.isFinite(sec) ? Math.min(sec, this.now().getTime()) : this.now().getTime()).toISOString();
    const { conversations } = this.d;
    // Dispatch is queued for after commit; if it throws, roll the insert back so a redelivery still triggers the agent once.
    const r = conversations.db.transaction(() => {
      const incoming = conversations.ingestMessage(ch.shopId, {
        channel: TELEGRAM_CHANNEL,
        conversationExternalId: chatId,
        customer: { externalId: chatId, displayName: name, handle: str(from.username) },
        externalId: `${chatId}:${messageId}`,
        text,
        attachments,
        occurredAt,
      });
      if (!incoming.duplicated) {
        try {
          this.d.onInbound(ch.shopId, incoming.conversation.id, incoming.message.id);
        } catch {
          throw new ConnectorError('TEMPORARY_FAILURE', 'Telegram inbound dispatch failed');
        }
      }
      return incoming;
    });
    return !r.duplicated;
  }

  // ---------- outbound ----------

  /** Why a reply cannot be sent right now, or null. Telegram has no messaging window. */
  blockReason(shopId: string): 'ACCOUNT_NOT_CONNECTED' | null {
    return this.enabled && this.isConnected(shopId) ? null : 'ACCOUNT_NOT_CONNECTED';
  }

  isConnected(shopId: string): boolean {
    return this.d.repo.getChannel(shopId)?.status === 'connected';
  }

  /** Sends one text to the conversation's chat. Never retries; never throws for provider problems. */
  async send(shopId: string, conversationId: string, text: string): Promise<TelegramSendOutcome> {
    if (this.blockReason(shopId)) return { status: 'failed', code: 'ACCOUNT_NOT_CONNECTED' };
    const conv = this.d.conversations.getConversation(shopId, conversationId);
    if (!conv || conv.conversation.channel !== TELEGRAM_CHANNEL) return { status: 'failed', code: 'ACCOUNT_NOT_CONNECTED' };
    const chatId = conv.conversation.externalId;
    try {
      const r = await this.d.vault.withSecret(shopId, 'telegram_bot', (t) => this.d.api.sendMessage(t, chatId, text));
      if (r.status === 'sent') return { status: 'sent', externalId: `${chatId}:${r.messageId}` };
      if (r.status === 'uncertain') return r;
      if (r.authFailure) this.markNeedsReconnect(shopId, r.code);
      return { status: 'failed', code: r.code };
    } catch (e) {
      if (e instanceof CredentialMissingError) return { status: 'failed', code: 'ACCOUNT_NOT_CONNECTED' };
      if (e instanceof CredentialDecryptError || e instanceof CredentialsUnavailableError) return { status: 'failed', code: 'CREDENTIAL_ERROR' };
      throw e;
    }
  }
}
