import { sql } from 'drizzle-orm';
import type { DbHandle } from './db';
import { execute, queryRow, queryRows } from './dialect';

const DAY_MS = 86_400_000;
/** The feed looks this far back. */
const FEED_DAYS = 30;
const PAYMENT_PROBLEM_STATES = ['create_failed', 'failure', 'reversed', 'expired'];
const PAYMENT_PROBLEM_FLAGS = ['AMOUNT_MISMATCH', 'PAID_AFTER_CANCEL'];

type Order = { draftId: string; number: number; currency: string; totalMinor: number; customer: string | null };
export type FeedItem =
  /** The AI (or a member) asked for a person; `resolved` once someone marked it handled. */
  | { id: string; kind: 'handoff'; at: string; unread: boolean; conversationId: string; reason: string; resolved: boolean; customer: string | null }
  /** A new order draft (by the AI or a member). */
  | ({ id: string; kind: 'order_new'; at: string; unread: boolean; createdBy: 'ai' | 'user'; status: string } & Order)
  /** A payment link that failed, expired or was reversed, or a payment flagged by Hepson (amount mismatch, paid after cancel). */
  | ({ id: string; kind: 'payment_problem'; at: string; unread: boolean; state: string; flag: string | null } & Order)
  /** The TTN could not be created, or may exist without Hepson knowing. */
  | ({ id: string; kind: 'ttn_problem'; at: string; unread: boolean; ttnState: 'failed' | 'uncertain'; ttnError: string | null } & Order);
export type NotificationFeed = { seenAt: string | null; unread: number; items: FeedItem[] };

/**
 * P10 notification centre. The feed is computed from existing shop tables (escalations, order events, payments, TTN
 * state), so no writer can forget to add an item; read state is one `seenAt` marker per member and shop. Every query
 * filters by `shop_id`. Internal: no authorization here.
 */
export class NotificationRepository {
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async seenAt(shopId: string, userId: string): Promise<string | null> {
    return this.seenAtTx(shopId, userId);
  }

  /** Sync body of `seenAt`: runs inside the caller's transaction. Package-internal. */
  seenAtTx(shopId: string, userId: string): string | null {
    const r = queryRow<{ s: string }>(this.handle.db, sql`select seen_at as s from notification_reads where shop_id = ${shopId} and user_id = ${userId}`);
    return r?.s ?? null;
  }

  /** Newest first, at most `limit` items of the last 30 days; `unread` counts all unread items of that window. */
  async feed(shopId: string, userId: string, f: { limit?: number } = {}): Promise<NotificationFeed> {
    const limit = Math.min(Math.max(Math.trunc(f.limit ?? 30), 1), 100);
    const since = new Date(this.clock().getTime() - FEED_DAYS * DAY_MS).toISOString();
    const seenAt = this.seenAtTx(shopId, userId);
    const db = this.handle.db;
    const customer = sql`coalesce(cu.display_name, cu.handle) as customer`;
    const order = sql`d.id as "draftId", d.number as "number", d.currency as currency, d.total_minor as "totalMinor", ${customer}`;

    const handoffs = queryRows<{ id: string; at: string; conversationId: string; reason: string; resolved: number; customer: string | null }>(
      db,
      sql`select e.id, e.created_at as "at", e.conversation_id as "conversationId", e.reason, case when e.status = 'resolved' then 1 else 0 end as resolved, ${customer}
         from escalations e join shop_conversations c on c.id = e.conversation_id join customers cu on cu.id = c.customer_id
         where e.shop_id = ${shopId} and e.created_at >= ${since}`,
    );
    const orders = queryRows<Order & { id: string; at: string; createdBy: 'ai' | 'user'; status: string }>(
      db,
      sql`select ev.id, ev.created_at as "at", d.created_by as "createdBy", d.status, ${order}
         from order_events ev join order_drafts d on d.id = ev.draft_id and d.shop_id = ev.shop_id join customers cu on cu.id = d.customer_id
         where ev.shop_id = ${shopId} and ev.from_status is null and ev.to_status = 'pending_approval' and ev.created_at >= ${since}`,
    );
    const payments = queryRows<Order & { id: string; at: string; state: string; flag: string | null }>(
      db,
      sql`select pa.id, pa.updated_at as "at", pa.state, pa.flag, ${order}
         from order_payments pa join order_drafts d on d.id = pa.draft_id and d.shop_id = pa.shop_id join customers cu on cu.id = d.customer_id
         where pa.shop_id = ${shopId} and pa.updated_at >= ${since}
           and (pa.state in ${PAYMENT_PROBLEM_STATES} or pa.flag in ${PAYMENT_PROBLEM_FLAGS})`,
    );
    const ttns = queryRows<Order & { at: string; ttnState: 'failed' | 'uncertain'; ttnError: string | null }>(
      db,
      sql`select d.updated_at as "at", d.ttn_state as "ttnState", d.ttn_error as "ttnError", ${order}
         from order_drafts d join customers cu on cu.id = d.customer_id
         where d.shop_id = ${shopId} and d.ttn_state in ('failed', 'uncertain') and d.updated_at >= ${since}`,
    );

    const unread = (at: string) => !seenAt || at > seenAt;
    const all: FeedItem[] = [
      ...handoffs.map((r) => ({ ...r, id: `handoff:${r.id}`, kind: 'handoff' as const, resolved: !!r.resolved, unread: unread(r.at) })),
      ...orders.map((r) => ({ ...r, id: `order:${r.id}`, kind: 'order_new' as const, unread: unread(r.at) })),
      ...payments.map((r) => ({ ...r, id: `payment:${r.id}:${r.state}:${r.flag ?? ''}`, kind: 'payment_problem' as const, unread: unread(r.at) })),
      ...ttns.map((r) => ({ ...r, id: `ttn:${r.draftId}:${r.ttnState}`, kind: 'ttn_problem' as const, unread: unread(r.at) })),
    ].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
    return { seenAt, unread: all.filter((i) => i.unread).length, items: all.slice(0, limit) };
  }

  /** Marks everything up to now as seen. The marker never moves back. */
  async markSeen(shopId: string, userId: string): Promise<string> {
    const now = this.clock().toISOString();
    execute(
      this.handle.db,
      sql`insert into notification_reads (shop_id, user_id, seen_at) values (${shopId}, ${userId}, ${now})
         on conflict (shop_id, user_id) do update set seen_at = case when excluded.seen_at > notification_reads.seen_at then excluded.seen_at else notification_reads.seen_at end`,
    );
    return this.seenAtTx(shopId, userId)!;
  }
}
