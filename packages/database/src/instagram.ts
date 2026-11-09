import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { CredentialVault } from './credentials';
import type { Db, DbHandle } from './db';
import * as t from './schema';

export type InstagramChannelRow = typeof t.instagramChannels.$inferSelect;

/** Channel key of official-API Instagram conversations in the shop tables (distinct from the frozen browser path's `instagram`). */
export const INSTAGRAM_CHANNEL = 'instagram-official';

/** That Instagram account is already connected to another shop (or the same one via a different row). */
export class InstagramAccountTakenError extends Error {
  constructor() {
    super('this Instagram account is already connected to a shop');
    this.name = 'InstagramAccountTakenError';
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Non-secret Instagram channel state and single-use OAuth `state` values (D23). Internal: callers authorize. */
export class InstagramRepository {
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

  /** New random `state` for a user starting the connect flow for a shop. Only its hash is stored. */
  async createState(shopId: string, userId: string, ttlMs: number): Promise<string> {
    const state = randomBytes(24).toString('base64url');
    this.db
      .insert(t.instagramOauthStates)
      .values({ stateHash: sha(state), shopId, userId, expiresAt: new Date(this.clock().getTime() + ttlMs).toISOString() })
      .run();
    return state;
  }

  /** Consumes a `state`: valid once, before it expires. Unknown, reused and expired values return undefined. */
  async consumeState(state: string): Promise<{ shopId: string; userId: string } | undefined> {
    return this.handle.transaction(() => {
      const h = sha(state);
      const row = this.db.select().from(t.instagramOauthStates).where(eq(t.instagramOauthStates.stateHash, h)).get();
      if (!row) return undefined;
      this.db.delete(t.instagramOauthStates).where(eq(t.instagramOauthStates.stateHash, h)).run();
      return row.expiresAt > this.now() ? { shopId: row.shopId, userId: row.userId } : undefined;
    });
  }

  async purgeExpiredStates(): Promise<void> {
    this.db.delete(t.instagramOauthStates).where(lt(t.instagramOauthStates.expiresAt, this.now())).run();
  }

  async getChannel(shopId: string): Promise<InstagramChannelRow | undefined> {
    return this.getChannelTx(shopId);
  }

  /** Sync body of `getChannel`: runs inside the caller's transaction. Package-internal. */
  getChannelTx(shopId: string): InstagramChannelRow | undefined {
    return this.db.select().from(t.instagramChannels).where(eq(t.instagramChannels.shopId, shopId)).get();
  }

  async findByIgUserId(igUserId: string): Promise<InstagramChannelRow | undefined> {
    return this.findByIgUserIdTx(igUserId);
  }

  /** Sync body of `findByIgUserId`: runs inside the caller's transaction. Package-internal. */
  findByIgUserIdTx(igUserId: string): InstagramChannelRow | undefined {
    return this.db.select().from(t.instagramChannels).where(eq(t.instagramChannels.igUserId, igUserId)).get();
  }

  async listConnected(): Promise<InstagramChannelRow[]> {
    return this.db.select().from(t.instagramChannels).where(eq(t.instagramChannels.status, 'connected')).all();
  }

  /** Saves the channel and its token as one atomic step: an account claimed meanwhile must not replace its token. */
  async connect(shopId: string, c: { igUserId: string; username: string | null; tokenExpiresAt: string | null }, vault: CredentialVault, token: string): Promise<void> {
    this.handle.transaction(() => {
      this.upsertChannelTx(shopId, c);
      vault.saveTx(shopId, 'instagram', token);
    });
  }

  /** Links an account to a shop (re-connecting the same account to the same shop updates the row). */
  async upsertChannel(shopId: string, c: { igUserId: string; username: string | null; tokenExpiresAt: string | null }): Promise<InstagramChannelRow> {
    return this.upsertChannelTx(shopId, c);
  }

  /** Sync body of `upsertChannel`: runs inside the caller's transaction. Package-internal. */
  upsertChannelTx(shopId: string, c: { igUserId: string; username: string | null; tokenExpiresAt: string | null }): InstagramChannelRow {
    return this.handle.transaction(() => {
      const ts = this.now();
      const owner = this.findByIgUserIdTx(c.igUserId);
      if (owner && owner.shopId !== shopId) throw new InstagramAccountTakenError();
      const mine = this.getChannelTx(shopId);
      if (mine) {
        return this.db
          .update(t.instagramChannels)
          .set({
            igUserId: c.igUserId,
            username: c.username,
            status: 'connected',
            tokenExpiresAt: c.tokenExpiresAt,
            tokenRefreshedAt: ts,
            lastError: null,
            connectedAt: ts,
            updatedAt: ts,
            polledUntil: mine.igUserId === c.igUserId ? mine.polledUntil : null,
          })
          .where(eq(t.instagramChannels.id, mine.id))
          .returning()
          .get()!;
      }
      return this.db
        .insert(t.instagramChannels)
        .values({
          id: randomUUID(),
          shopId,
          igUserId: c.igUserId,
          username: c.username,
          status: 'connected',
          tokenExpiresAt: c.tokenExpiresAt,
          tokenRefreshedAt: ts,
          lastError: null,
          connectedAt: ts,
          updatedAt: ts,
        })
        .returning()
        .get();
    });
  }

  async setTokenRefreshed(shopId: string, tokenExpiresAt: string | null): Promise<void> {
    const ts = this.now();
    this.db.update(t.instagramChannels).set({ tokenExpiresAt, tokenRefreshedAt: ts, lastError: null, updatedAt: ts }).where(eq(t.instagramChannels.shopId, shopId)).run();
  }

  async setPolledUntil(shopId: string, iso: string): Promise<void> {
    this.db.update(t.instagramChannels).set({ polledUntil: iso }).where(eq(t.instagramChannels.shopId, shopId)).run();
  }

  /** Records a short code without changing the connection status. */
  async setError(shopId: string, code: string): Promise<void> {
    this.db.update(t.instagramChannels).set({ lastError: code, updatedAt: this.now() }).where(eq(t.instagramChannels.shopId, shopId)).run();
  }

  async setNeedsReconnect(shopId: string, code: string): Promise<boolean> {
    const r = this.db
      .update(t.instagramChannels)
      .set({ status: 'needs_reconnect', lastError: code, updatedAt: this.now() })
      .where(and(eq(t.instagramChannels.shopId, shopId), eq(t.instagramChannels.status, 'connected')))
      .run();
    return r.changes > 0;
  }

  async deleteChannel(shopId: string): Promise<boolean> {
    return this.db.delete(t.instagramChannels).where(eq(t.instagramChannels.shopId, shopId)).run().changes > 0;
  }
}
