import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db, DbHandle } from './db';
import * as t from './schema';

export type AccountRow = typeof t.storeAccounts.$inferSelect;
export type ConversationRow = typeof t.conversations.$inferSelect;
export type MessageRow = typeof t.messages.$inferSelect;
export type OutboxRow = typeof t.outbox.$inferSelect;
export type EventRow = typeof t.events.$inferSelect;
export type ApiKeyRow = typeof t.apiKeys.$inferSelect;

const now = () => new Date().toISOString();
export const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');

/**
 * Data access. Every method touching tenant data takes `accountId` and filters by it;
 * there is no method that reads across accounts except `listAccounts` / `findApiKey` (admin/auth).
 */
export class Store {
  readonly db: Db;
  constructor(readonly handle: DbHandle) {
    this.db = handle.db;
  }

  // ---- accounts ----
  createAccount(a: { label: string; connectorType: AccountRow['connectorType']; consentRecordedAt: string | null; expectedInstagramHandle?: string | null }): AccountRow {
    const row: AccountRow = {
      id: randomUUID(),
      label: a.label,
      connectorType: a.connectorType,
      status: 'disconnected',
      enabled: true,
      outboundEnabled: false,
      consentRecordedAt: a.consentRecordedAt,
      expectedInstagramHandle: a.expectedInstagramHandle ?? null,
      lastAuthValidatedAt: null,
      lastErrorCode: null,
      paused: false,
      createdAt: now(),
      updatedAt: now(),
    };
    this.db.insert(t.storeAccounts).values(row).run();
    return row;
  }
  listAccounts(onlyId?: string): AccountRow[] {
    const q = this.db.select().from(t.storeAccounts);
    return (onlyId ? q.where(eq(t.storeAccounts.id, onlyId)) : q).orderBy(asc(t.storeAccounts.createdAt)).all();
  }
  getAccount(id: string): AccountRow | undefined {
    return this.db.select().from(t.storeAccounts).where(eq(t.storeAccounts.id, id)).get();
  }
  updateAccount(id: string, patch: Partial<Omit<AccountRow, 'id' | 'createdAt'>>): void {
    this.db
      .update(t.storeAccounts)
      .set({ ...patch, updatedAt: now() })
      .where(eq(t.storeAccounts.id, id))
      .run();
  }

  // ---- api keys ----
  /** Returns the plaintext key ONCE; only the hash is stored. */
  createApiKey(name: string, accountId: string | null): { key: string; row: ApiKeyRow } {
    const key = `hep_${randomBytes(32).toString('base64url')}`;
    const row: ApiKeyRow = { id: randomUUID(), accountId, name, hashedKey: hashKey(key), createdAt: now(), revokedAt: null };
    this.db.insert(t.apiKeys).values(row).run();
    return { key, row };
  }
  findApiKey(key: string): ApiKeyRow | undefined {
    return this.db
      .select()
      .from(t.apiKeys)
      .where(and(eq(t.apiKeys.hashedKey, hashKey(key)), isNull(t.apiKeys.revokedAt)))
      .get();
  }
  revokeApiKey(id: string): void {
    this.db.update(t.apiKeys).set({ revokedAt: now() }).where(eq(t.apiKeys.id, id)).run();
  }

  // ---- conversations ----
  upsertConversation(
    accountId: string,
    o: { providerId: string; title: string; participants: string[]; lastMessageAt: string | null; unread: boolean | null },
  ): { row: ConversationRow; created: boolean; changed: boolean } {
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(t.conversations)
        .where(and(eq(t.conversations.accountId, accountId), eq(t.conversations.providerId, o.providerId)))
        .get();
      if (!existing) {
        const row: ConversationRow = {
          id: randomUUID(),
          accountId,
          providerId: o.providerId,
          participants: o.participants,
          title: o.title,
          lastObservedAt: now(),
          lastMessageAt: o.lastMessageAt,
          unread: o.unread,
        };
        tx.insert(t.conversations).values(row).run();
        return { row, created: true, changed: true };
      }
      const lastMessageAt = o.lastMessageAt ?? existing.lastMessageAt;
      const changed =
        existing.title !== o.title ||
        JSON.stringify(existing.participants) !== JSON.stringify(o.participants) ||
        existing.lastMessageAt !== lastMessageAt ||
        existing.unread !== o.unread;
      const row = { ...existing, title: o.title, participants: o.participants, lastMessageAt, unread: o.unread, lastObservedAt: now() };
      tx.update(t.conversations)
        .set(row)
        .where(and(eq(t.conversations.id, existing.id), eq(t.conversations.accountId, accountId)))
        .run();
      return { row, created: false, changed };
    });
  }
  getConversation(accountId: string, id: string): ConversationRow | undefined {
    return this.db
      .select()
      .from(t.conversations)
      .where(and(eq(t.conversations.accountId, accountId), eq(t.conversations.id, id)))
      .get();
  }
  /** Keyset pagination; newest first. cursor = `${lastMessageAt}|${id}`. */
  listConversations(accountId: string, limit: number, cursor?: string): { items: ConversationRow[]; nextCursor: string | null } {
    const key = sql<string>`coalesce(${t.conversations.lastMessageAt}, '')`;
    const conds = [eq(t.conversations.accountId, accountId)];
    if (cursor) {
      const i = cursor.lastIndexOf('|');
      const ts = cursor.slice(0, i);
      const id = cursor.slice(i + 1);
      conds.push(or(sql`${key} < ${ts}`, and(sql`${key} = ${ts}`, lt(t.conversations.id, id)))!);
    }
    const rows = this.db
      .select()
      .from(t.conversations)
      .where(and(...conds))
      .orderBy(desc(key), desc(t.conversations.id))
      .limit(limit + 1)
      .all();
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? `${last.lastMessageAt ?? ''}|${last.id}` : null };
  }

  // ---- messages ----
  /** Insert if fingerprint unseen for this account. Returns the row when inserted, else null. */
  insertMessageIfNew(accountId: string, m: Omit<MessageRow, 'id' | 'seq' | 'accountId'>): MessageRow | null {
    return this.db.transaction((tx) => {
      const seq =
        (tx
          .select({ m: sql<number>`coalesce(max(${t.messages.seq}), 0)` })
          .from(t.messages)
          .where(eq(t.messages.accountId, accountId))
          .get()?.m ?? 0) + 1;
      const row: MessageRow = { ...m, id: randomUUID(), accountId, seq };
      const res = tx.insert(t.messages).values(row).onConflictDoNothing().run();
      return res.changes === 1 ? row : null;
    });
  }
  findMessageByFingerprint(accountId: string, fp: string): MessageRow | undefined {
    return this.db
      .select()
      .from(t.messages)
      .where(and(eq(t.messages.accountId, accountId), eq(t.messages.fingerprint, fp)))
      .get();
  }
  /** Local outgoing message (fingerprint `out:*`) awaiting reconciliation with the provider-observed copy. */
  findAdoptableOutgoing(accountId: string, conversationId: string, text: string): MessageRow | undefined {
    return this.db
      .select()
      .from(t.messages)
      .where(
        and(
          eq(t.messages.accountId, accountId),
          eq(t.messages.conversationId, conversationId),
          eq(t.messages.direction, 'outgoing'),
          eq(t.messages.text, text),
          sql`${t.messages.fingerprint} like 'out:%'`,
        ),
      )
      .orderBy(asc(t.messages.seq))
      .get();
  }
  setMessageFingerprint(accountId: string, id: string, fingerprint: string, providerId: string | null): void {
    this.db
      .update(t.messages)
      .set({ fingerprint, providerId, deliveryStatus: 'sent' })
      .where(and(eq(t.messages.accountId, accountId), eq(t.messages.id, id)))
      .run();
  }
  findUncertainOutbox(accountId: string, conversationId: string, body: string): OutboxRow | undefined {
    return this.db
      .select()
      .from(t.outbox)
      .where(and(eq(t.outbox.accountId, accountId), eq(t.outbox.conversationId, conversationId), eq(t.outbox.body, body), eq(t.outbox.status, 'uncertain')))
      .orderBy(asc(t.outbox.createdAt))
      .get();
  }
  updateMessage(accountId: string, id: string, patch: Partial<Pick<MessageRow, 'deliveryStatus' | 'providerId' | 'sentAt'>>): void {
    this.db
      .update(t.messages)
      .set(patch)
      .where(and(eq(t.messages.accountId, accountId), eq(t.messages.id, id)))
      .run();
  }
  /** Older-first page output; cursor = seq of the oldest returned message (pass back to go older). */
  listMessages(accountId: string, conversationId: string, limit: number, cursor?: string): { items: MessageRow[]; nextCursor: string | null } {
    const conds = [eq(t.messages.accountId, accountId), eq(t.messages.conversationId, conversationId)];
    if (cursor) conds.push(lt(t.messages.seq, Number(cursor)));
    const rows = this.db
      .select()
      .from(t.messages)
      .where(and(...conds))
      .orderBy(desc(t.messages.seq))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    const oldest = page[page.length - 1];
    return { items: page.reverse(), nextCursor: rows.length > limit && oldest ? String(oldest.seq) : null };
  }
  hasAnyMessages(accountId: string): boolean {
    return !!this.db.select({ id: t.messages.id }).from(t.messages).where(eq(t.messages.accountId, accountId)).limit(1).get();
  }

  // ---- outbox ----
  /** Atomic create-or-return by (accountId, idempotencyKey). */
  createOutbox(accountId: string, o: { conversationId: string; idempotencyKey: string; body: string; bodyHash: string; dryRun: boolean }): { row: OutboxRow; created: boolean } {
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(t.outbox)
        .where(and(eq(t.outbox.accountId, accountId), eq(t.outbox.idempotencyKey, o.idempotencyKey)))
        .get();
      if (existing) return { row: existing, created: false };
      const row: OutboxRow = {
        id: randomUUID(),
        accountId,
        conversationId: o.conversationId,
        idempotencyKey: o.idempotencyKey,
        body: o.body,
        bodyHash: o.bodyHash,
        status: 'queued',
        errorCode: null,
        dryRun: o.dryRun,
        reviewedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      tx.insert(t.outbox).values(row).run();
      return { row, created: true };
    });
  }
  findOutboxByKey(accountId: string, key: string): OutboxRow | undefined {
    return this.db
      .select()
      .from(t.outbox)
      .where(and(eq(t.outbox.accountId, accountId), eq(t.outbox.idempotencyKey, key)))
      .get();
  }
  getOutbox(accountId: string, id: string): OutboxRow | undefined {
    return this.db
      .select()
      .from(t.outbox)
      .where(and(eq(t.outbox.accountId, accountId), eq(t.outbox.id, id)))
      .get();
  }
  listOutbox(accountId: string, statuses?: OutboxRow['status'][]): OutboxRow[] {
    const conds = [eq(t.outbox.accountId, accountId)];
    if (statuses) conds.push(inArray(t.outbox.status, statuses));
    return this.db
      .select()
      .from(t.outbox)
      .where(and(...conds))
      .orderBy(desc(t.outbox.createdAt))
      .limit(100)
      .all();
  }
  /** Compare-and-set transition; returns false if current status was not `from`. */
  transitionOutbox(accountId: string, id: string, from: OutboxRow['status'][], to: OutboxRow['status'], errorCode: string | null = null): boolean {
    const r = this.db
      .update(t.outbox)
      .set({ status: to, errorCode, updatedAt: now() })
      .where(and(eq(t.outbox.accountId, accountId), eq(t.outbox.id, id), inArray(t.outbox.status, from)))
      .run();
    return r.changes === 1;
  }
  markOutboxReviewed(accountId: string, id: string): void {
    this.db
      .update(t.outbox)
      .set({ reviewedAt: now(), updatedAt: now() })
      .where(and(eq(t.outbox.accountId, accountId), eq(t.outbox.id, id)))
      .run();
  }

  // ---- events ----
  appendEvent(accountId: string, type: string, payload: Record<string, unknown>): EventRow {
    return this.db.transaction((tx) => {
      const seq =
        (tx
          .select({ m: sql<number>`coalesce(max(${t.events.sequence}), 0)` })
          .from(t.events)
          .where(eq(t.events.accountId, accountId))
          .get()?.m ?? 0) + 1;
      const row: EventRow = { id: randomUUID(), accountId, type, payload, occurredAt: now(), sequence: seq };
      tx.insert(t.events).values(row).run();
      return row;
    });
  }
  listEvents(accountId: string, afterSequence: number, limit: number): EventRow[] {
    return this.db
      .select()
      .from(t.events)
      .where(and(eq(t.events.accountId, accountId), gt(t.events.sequence, afterSequence)))
      .orderBy(asc(t.events.sequence))
      .limit(limit)
      .all();
  }
  lastEventSequence(accountId: string): number {
    return (
      this.db
        .select({ m: sql<number>`coalesce(max(${t.events.sequence}), 0)` })
        .from(t.events)
        .where(eq(t.events.accountId, accountId))
        .get()?.m ?? 0
    );
  }

  // ---- connector state ----
  getState(accountId: string) {
    return this.db.select().from(t.connectorState).where(eq(t.connectorState.accountId, accountId)).get();
  }
  patchState(accountId: string, patch: Partial<Omit<typeof t.connectorState.$inferInsert, 'accountId'>>): void {
    this.db
      .insert(t.connectorState)
      .values({ accountId, ...patch })
      .onConflictDoUpdate({ target: t.connectorState.accountId, set: patch })
      .run();
  }

  // ---- retention / export / delete ----
  purgeOlderThan(accountId: string, days: number): { messages: number; events: number } {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const m = this.db
      .delete(t.messages)
      .where(and(eq(t.messages.accountId, accountId), lt(t.messages.observedAt, cutoff)))
      .run().changes;
    const e = this.db
      .delete(t.events)
      .where(and(eq(t.events.accountId, accountId), lt(t.events.occurredAt, cutoff)))
      .run().changes;
    return { messages: m, events: e };
  }
  /** Safe export: conversations + messages + outbox only. Never auth/profile material. */
  exportAccountData(accountId: string) {
    return {
      exportedAt: now(),
      accountId,
      conversations: this.db.select().from(t.conversations).where(eq(t.conversations.accountId, accountId)).all(),
      messages: this.db.select().from(t.messages).where(eq(t.messages.accountId, accountId)).orderBy(asc(t.messages.seq)).all(),
      outbox: this.db.select().from(t.outbox).where(eq(t.outbox.accountId, accountId)).all(),
    };
  }
  /** Deletes cached messages/conversations/outbox (not events sequence, not account). */
  deleteAccountData(accountId: string): void {
    this.db.transaction((tx) => {
      tx.delete(t.outbox).where(eq(t.outbox.accountId, accountId)).run();
      tx.delete(t.messages).where(eq(t.messages.accountId, accountId)).run();
      tx.delete(t.conversations).where(eq(t.conversations.accountId, accountId)).run();
      tx.update(t.connectorState).set({ baselineDone: false, syncCursor: null }).where(eq(t.connectorState.accountId, accountId)).run();
    });
  }
}
