import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { CredentialVault } from './credentials';
import type { Db, DbHandle } from './db';
import * as t from './schema';

export type TelegramChannelRow = typeof t.telegramChannels.$inferSelect;

/** Channel key of Telegram conversations in the shop tables (D27). */
export const TELEGRAM_CHANNEL = 'telegram';

/** That bot is already connected to another shop. */
export class TelegramBotTakenError extends Error {
  constructor() {
    super('this Telegram bot is already connected to a shop');
    this.name = 'TelegramBotTakenError';
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest();

/** Non-secret Telegram channel state (D27). Internal: callers authorize. */
export class TelegramRepository {
  readonly db: Db;
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }
  private now() {
    return this.clock().toISOString();
  }

  async getChannel(shopId: string): Promise<TelegramChannelRow | undefined> {
    return this.getChannelTx(shopId);
  }

  /** Sync body of `getChannel`: runs inside the caller's transaction. Package-internal. */
  getChannelTx(shopId: string): TelegramChannelRow | undefined {
    return this.db.select().from(t.telegramChannels).where(eq(t.telegramChannels.shopId, shopId)).get();
  }

  async findByBotId(botId: string): Promise<TelegramChannelRow | undefined> {
    return this.findByBotIdTx(botId);
  }

  /** Sync body of `findByBotId`: runs inside the caller's transaction. Package-internal. */
  findByBotIdTx(botId: string): TelegramChannelRow | undefined {
    return this.db.select().from(t.telegramChannels).where(eq(t.telegramChannels.botId, botId)).get();
  }

  async findByWebhookId(webhookId: string): Promise<TelegramChannelRow | undefined> {
    return this.db.select().from(t.telegramChannels).where(eq(t.telegramChannels.webhookId, webhookId)).get();
  }

  /** Constant-time check of a webhook's `X-Telegram-Bot-Api-Secret-Token` against the stored hash. */
  secretMatches(ch: TelegramChannelRow, given: string): boolean {
    return timingSafeEqual(sha(given), Buffer.from(ch.webhookAuthHash, 'hex'));
  }

  /** Saves the channel and its token as one atomic step. */
  async connect(shopId: string, c: { botId: string; botUsername: string | null; webhookId: string; secret: string }, vault: CredentialVault, token: string): Promise<void> {
    this.handle.transaction(() => {
      this.upsertChannelTx(shopId, c);
      vault.saveTx(shopId, 'telegram_bot', token);
    });
  }

  /** Links a bot to a shop with a fresh webhook path and secret (re-connecting replaces both). */
  async upsertChannel(shopId: string, c: { botId: string; botUsername: string | null; webhookId: string; secret: string }): Promise<TelegramChannelRow> {
    return this.upsertChannelTx(shopId, c);
  }

  /** Sync body of `upsertChannel`: runs inside the caller's transaction. Package-internal. */
  upsertChannelTx(shopId: string, c: { botId: string; botUsername: string | null; webhookId: string; secret: string }): TelegramChannelRow {
    return this.handle.transaction(() => {
      const ts = this.now();
      const owner = this.findByBotIdTx(c.botId);
      if (owner && owner.shopId !== shopId) throw new TelegramBotTakenError();
      const values = {
        botId: c.botId,
        botUsername: c.botUsername,
        webhookId: c.webhookId,
        webhookAuthHash: sha(c.secret).toString('hex'),
        status: 'connected' as const,
        lastError: null,
        connectedAt: ts,
        updatedAt: ts,
      };
      const mine = this.getChannelTx(shopId);
      if (mine) return this.db.update(t.telegramChannels).set(values).where(eq(t.telegramChannels.id, mine.id)).returning().get()!;
      return this.db
        .insert(t.telegramChannels)
        .values({ id: randomUUID(), shopId, ...values })
        .returning()
        .get();
    });
  }

  async setNeedsReconnect(shopId: string, code: string): Promise<boolean> {
    const r = this.db
      .update(t.telegramChannels)
      .set({ status: 'needs_reconnect', lastError: code, updatedAt: this.now() })
      .where(and(eq(t.telegramChannels.shopId, shopId), eq(t.telegramChannels.status, 'connected')))
      .run();
    return r.changes > 0;
  }

  async deleteChannel(shopId: string): Promise<boolean> {
    return this.db.delete(t.telegramChannels).where(eq(t.telegramChannels.shopId, shopId)).run().changes > 0;
  }
}
