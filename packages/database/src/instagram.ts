import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
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
  createState(shopId: string, userId: string, ttlMs: number): string {
    const state = randomBytes(24).toString('base64url');
    this.db
      .insert(t.instagramOauthStates)
      .values({ stateHash: sha(state), shopId, userId, expiresAt: new Date(this.clock().getTime() + ttlMs).toISOString() })
      .run();
    return state;
  }

  /** Consumes a `state`: valid once, before it expires. Unknown, reused and expired values return undefined. */
  consumeState(state: string): { shopId: string; userId: string } | undefined {
    return this.handle.raw.transaction(() => {
      const h = sha(state);
      const row = this.db.select().from(t.instagramOauthStates).where(eq(t.instagramOauthStates.stateHash, h)).get();
      if (!row) return undefined;
      this.db.delete(t.instagramOauthStates).where(eq(t.instagramOauthStates.stateHash, h)).run();
      return row.expiresAt > this.now() ? { shopId: row.shopId, userId: row.userId } : undefined;
    })();
  }

  purgeExpiredStates(): void {
    this.db.delete(t.instagramOauthStates).where(lt(t.instagramOauthStates.expiresAt, this.now())).run();
  }

  getChannel(shopId: string): InstagramChannelRow | undefined {
    return this.db.select().from(t.instagramChannels).where(eq(t.instagramChannels.shopId, shopId)).get();
  }

  findByIgUserId(igUserId: string): InstagramChannelRow | undefined {
    return this.db.select().from(t.instagramChannels).where(eq(t.instagramChannels.igUserId, igUserId)).get();
  }

  listConnected(): InstagramChannelRow[] {
    return this.db.select().from(t.instagramChannels).where(eq(t.instagramChannels.status, 'connected')).all();
  }

  /** Links an account to a shop (re-connecting the same account to the same shop updates the row). */
  upsertChannel(shopId: string, c: { igUserId: string; username: string | null; tokenExpiresAt: string | null }): InstagramChannelRow {
    return this.handle.raw.transaction(() => {
      const ts = this.now();
      const owner = this.findByIgUserId(c.igUserId);
      if (owner && owner.shopId !== shopId) throw new InstagramAccountTakenError();
      const mine = this.getChannel(shopId);
      if (mine) {
        return this.db
          .update(t.instagramChannels)
          .set({ igUserId: c.igUserId, username: c.username, status: 'connected', tokenExpiresAt: c.tokenExpiresAt, tokenRefreshedAt: ts, lastError: null, connectedAt: ts, updatedAt: ts })
          .where(eq(t.instagramChannels.id, mine.id))
          .returning()
          .get()!;
      }
      return this.db
        .insert(t.instagramChannels)
        .values({ id: randomUUID(), shopId, igUserId: c.igUserId, username: c.username, status: 'connected', tokenExpiresAt: c.tokenExpiresAt, tokenRefreshedAt: ts, lastError: null, connectedAt: ts, updatedAt: ts })
        .returning()
        .get();
    })();
  }

  setTokenRefreshed(shopId: string, tokenExpiresAt: string | null): void {
    const ts = this.now();
    this.db.update(t.instagramChannels).set({ tokenExpiresAt, tokenRefreshedAt: ts, lastError: null, updatedAt: ts }).where(eq(t.instagramChannels.shopId, shopId)).run();
  }

  setPolledUntil(shopId: string, iso: string): void {
    this.db.update(t.instagramChannels).set({ polledUntil: iso }).where(eq(t.instagramChannels.shopId, shopId)).run();
  }

  /** Records a short code without changing the connection status. */
  setError(shopId: string, code: string): void {
    this.db.update(t.instagramChannels).set({ lastError: code, updatedAt: this.now() }).where(eq(t.instagramChannels.shopId, shopId)).run();
  }

  setNeedsReconnect(shopId: string, code: string): boolean {
    const r = this.db
      .update(t.instagramChannels)
      .set({ status: 'needs_reconnect', lastError: code, updatedAt: this.now() })
      .where(and(eq(t.instagramChannels.shopId, shopId), eq(t.instagramChannels.status, 'connected')))
      .run();
    return r.changes > 0;
  }

  deleteChannel(shopId: string): boolean {
    return this.db.delete(t.instagramChannels).where(eq(t.instagramChannels.shopId, shopId)).run().changes > 0;
  }
}
