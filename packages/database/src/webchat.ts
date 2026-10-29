import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import * as t from './schema';

export type WebChatConfigRow = typeof t.webChatConfigs.$inferSelect;
export type WebChatSessionRow = typeof t.webChatSessions.$inferSelect;

export const WIDGET_KEY_PREFIX = 'hwk_';
export const VISITOR_TOKEN_PREFIX = 'hwv_';
/** Channel key of website chat conversations in the shop tables (D11). */
export const WEB_CHANNEL = 'website';

export class WebChatValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid web chat input: ${issues.join('; ')}`);
    this.name = 'WebChatValidationError';
  }
}

/** `scheme://host[:port]` exactly as a browser sends it in `Origin`: no path, no trailing slash, no wildcard. */
const origin = z.string().trim().refine((o) => {
  try {
    const u = new URL(o);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o && !u.username && !u.password && !o.includes('*');
  } catch {
    return false;
  }
}, 'must be an exact origin such as https://shop.example (no path, no wildcard)');
const configInput = z.strictObject({ enabled: z.boolean().optional(), allowedOrigins: z.array(origin).max(20).optional() });
const sessionInput = z.strictObject({ displayName: z.string().trim().min(1).max(60).nullish() });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const newKey = () => WIDGET_KEY_PREFIX + randomBytes(18).toString('base64url');

/**
 * Website chat configuration and anonymous visitor sessions (Feature 10). Internal: callers authorize.
 * Chat messages themselves live in the shared customer/conversation/message tables under channel `website`.
 */
export class WebChatRepository {
  readonly db: Db;
  constructor(
    handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }
  private now() {
    return this.clock().toISOString();
  }

  getConfig(shopId: string): WebChatConfigRow | undefined {
    return this.db.select().from(t.webChatConfigs).where(eq(t.webChatConfigs.shopId, shopId)).get();
  }

  findByKey(widgetKey: string): WebChatConfigRow | undefined {
    return this.db.select().from(t.webChatConfigs).where(eq(t.webChatConfigs.widgetKey, widgetKey)).get();
  }

  /** Creates the config (disabled, no origins, fresh key) on first write. Origins are normalized to lowercase and deduplicated. */
  updateConfig(shopId: string, input: z.input<typeof configInput>): WebChatConfigRow {
    const r = configInput.safeParse(input);
    if (!r.success) throw new WebChatValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
    const cur = this.getConfig(shopId);
    const origins = r.data.allowedOrigins ? [...new Set(r.data.allowedOrigins.map((o) => o.toLowerCase()))] : (cur?.allowedOrigins ?? []);
    const row: WebChatConfigRow = { shopId, enabled: r.data.enabled ?? cur?.enabled ?? false, widgetKey: cur?.widgetKey ?? newKey(), allowedOrigins: origins, updatedAt: this.now() };
    this.db
      .insert(t.webChatConfigs)
      .values(row)
      .onConflictDoUpdate({ target: t.webChatConfigs.shopId, set: { enabled: row.enabled, allowedOrigins: row.allowedOrigins, updatedAt: row.updatedAt } })
      .run();
    return row;
  }

  /** New widget key (old snippets stop working at once). Existing visitor sessions stay valid for the new key. */
  rotateKey(shopId: string): WebChatConfigRow {
    if (!this.getConfig(shopId)) this.updateConfig(shopId, {});
    return this.db.update(t.webChatConfigs).set({ widgetKey: newKey(), updatedAt: this.now() }).where(eq(t.webChatConfigs.shopId, shopId)).returning().get()!;
  }

  createSession(shopId: string, input: z.input<typeof sessionInput> = {}, ttlMs: number): { session: WebChatSessionRow; token: string } {
    const r = sessionInput.safeParse(input);
    if (!r.success) throw new WebChatValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
    const token = VISITOR_TOKEN_PREFIX + randomBytes(24).toString('base64url');
    const now = this.clock();
    const session: WebChatSessionRow = {
      id: randomUUID(),
      shopId,
      visitorId: randomUUID(),
      displayName: r.data.displayName ?? null,
      tokenHash: sha(token),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.db.insert(t.webChatSessions).values(session).run();
    return { session, token };
  }

  /** The live session behind a token, only for that shop (a token never works for another shop's key). */
  findSession(shopId: string, token: string): WebChatSessionRow | undefined {
    if (!token.startsWith(VISITOR_TOKEN_PREFIX) || token.length > 200) return undefined;
    return this.db
      .select()
      .from(t.webChatSessions)
      .where(and(eq(t.webChatSessions.shopId, shopId), eq(t.webChatSessions.tokenHash, sha(token)), gt(t.webChatSessions.expiresAt, this.now())))
      .get();
  }

  touchSession(sessionId: string): void {
    this.db.update(t.webChatSessions).set({ lastSeenAt: this.now() }).where(eq(t.webChatSessions.id, sessionId)).run();
  }

  /** Visitor messages stored since `since` for the shop (daily cost cap). */
  countInboundSince(shopId: string, since: string): number {
    return this.db
      .select({ n: sql<number>`count(*)` })
      .from(t.shopMessages)
      .innerJoin(t.shopConversations, eq(t.shopConversations.id, t.shopMessages.conversationId))
      .where(and(eq(t.shopMessages.shopId, shopId), eq(t.shopConversations.channel, WEB_CHANNEL), eq(t.shopMessages.direction, 'incoming'), gt(t.shopMessages.createdAt, since)))
      .get()!.n;
  }

  /** Deletes sessions that expired more than a week ago. Conversations and messages stay. */
  purgeExpiredSessions(): number {
    const cutoff = new Date(this.clock().getTime() - 7 * 86_400_000).toISOString();
    return this.db.delete(t.webChatSessions).where(lt(t.webChatSessions.expiresAt, cutoff)).run().changes;
  }
}
