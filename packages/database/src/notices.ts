import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, DbHandle } from './db';
import { CUSTOMER_NOTICE_EVENTS } from './order-kinds';
import { orderedId } from './ids';
import * as t from './schema';

export { CUSTOMER_NOTICE_EVENTS, CUSTOMER_NOTICE_STATES } from './order-kinds';
export type CustomerNoticeRow = typeof t.customerNotices.$inferSelect;
export type CustomerNoticeEvent = (typeof CUSTOMER_NOTICE_EVENTS)[number];
export type CustomerNoticeOutcome = 'sent' | 'uncertain' | 'failed' | 'skipped';

/** Listeners per database: every repository instance on the same handle wakes the same sender. */
const listeners = new WeakMap<DbHandle, Set<() => void>>();

/** Calls `fn` after a notice was queued (on a microtask, so after the queuing transaction committed). Returns the unsubscribe. */
export function onCustomerNoticeQueued(handle: DbHandle, fn: () => void): () => void {
  const set = listeners.get(handle) ?? new Set();
  listeners.set(handle, set);
  set.add(fn);
  return () => set.delete(fn);
}

/**
 * The customer notice queue (P6). `enqueue` runs inside the order transition's transaction; the sender claims a row
 * (compare-and-set) before its one attempt, so each (order, event) is sent at most once. Every method but the sender's
 * cross-shop listing takes `shopId` first and filters by it.
 */
export class CustomerNoticeRepository {
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

  /** Queues the notice unless this (order, event) already has one. True when a row was added. */
  async enqueue(shopId: string, draftId: string, event: CustomerNoticeEvent): Promise<boolean> {
    return this.enqueueTx(shopId, draftId, event);
  }

  /** Sync body of `enqueue`: runs inside the caller's transaction. Package-internal. */
  enqueueTx(shopId: string, draftId: string, event: CustomerNoticeEvent): boolean {
    const ts = this.now();
    const r = this.db
      .insert(t.customerNotices)
      .values({ id: orderedId(), shopId, draftId, event, state: 'pending', code: null, createdAt: ts, updatedAt: ts })
      .onConflictDoNothing()
      .run();
    if (!r.changes) return false;
    for (const fn of listeners.get(this.handle) ?? []) queueMicrotask(fn);
    return true;
  }

  /** Pending notices across shops, oldest first (an order's notices go out in the order of its transitions). */
  async listPending(limit = 100): Promise<CustomerNoticeRow[]> {
    return this.db
      .select()
      .from(t.customerNotices)
      .where(eq(t.customerNotices.state, 'pending'))
      .orderBy(asc(t.customerNotices.createdAt), asc(t.customerNotices.id))
      .limit(limit)
      .all();
  }

  /** `pending` to `sending`: true for exactly one caller. */
  async claim(shopId: string, id: string): Promise<boolean> {
    const r = this.db
      .update(t.customerNotices)
      .set({ state: 'sending', updatedAt: this.now() })
      .where(and(eq(t.customerNotices.shopId, shopId), eq(t.customerNotices.id, id), eq(t.customerNotices.state, 'pending')))
      .run();
    return r.changes > 0;
  }

  /** Records the outcome of the one attempt. */
  async finish(shopId: string, id: string, state: CustomerNoticeOutcome, code: string | null): Promise<void> {
    this.db
      .update(t.customerNotices)
      .set({ state, code: code?.slice(0, 64) ?? null, updatedAt: this.now() })
      .where(and(eq(t.customerNotices.shopId, shopId), eq(t.customerNotices.id, id), eq(t.customerNotices.state, 'sending')))
      .run();
  }

  /** At startup: a notice left `sending` by a crash may or may not have gone out, so it becomes `uncertain` (never resent). */
  async recoverInterrupted(): Promise<number> {
    return this.db.update(t.customerNotices).set({ state: 'uncertain', code: 'INTERRUPTED', updatedAt: this.now() }).where(eq(t.customerNotices.state, 'sending')).run().changes;
  }

  async listFor(shopId: string, draftId: string): Promise<CustomerNoticeRow[]> {
    return this.listForDraftsTx(shopId, [draftId]).get(draftId) ?? [];
  }

  /** Notices of several orders at once, oldest first per order (the dashboard's order list). */
  async listForDrafts(shopId: string, draftIds: string[]): Promise<Map<string, CustomerNoticeRow[]>> {
    return this.listForDraftsTx(shopId, draftIds);
  }

  /** Sync body of `listForDrafts`: runs inside the caller's transaction. Package-internal. */
  listForDraftsTx(shopId: string, draftIds: string[]): Map<string, CustomerNoticeRow[]> {
    const out = new Map<string, CustomerNoticeRow[]>();
    if (!draftIds.length) return out;
    const rows = this.db
      .select()
      .from(t.customerNotices)
      .where(and(eq(t.customerNotices.shopId, shopId), inArray(t.customerNotices.draftId, draftIds)))
      .orderBy(asc(t.customerNotices.createdAt), asc(t.customerNotices.id))
      .all();
    for (const r of rows) out.set(r.draftId, [...(out.get(r.draftId) ?? []), r]);
    return out;
  }
}
