import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DbHandle } from './db';
import { queryRow, queryRows, secondsBetween } from './dialect';

export class StatsValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid stats query: ${issues.join('; ')}`);
    this.name = 'StatsValidationError';
  }
}

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
const DEFAULT_DAYS = 30;
const isoTime = z.iso.datetime({ offset: true });
const periodInput = z.strictObject({ from: isoTime.optional(), to: isoTime.optional() });

export type StatsPeriod = { from: string; to: string };
export type ShopStats = {
  period: StatsPeriod;
  messages: { incoming: number; outgoingAi: number; outgoingHuman: number; outgoingSystem: number; failedOutgoing: number };
  conversations: { active: number; newCustomers: number; aiPausedNow: number };
  ai: {
    runs: number;
    byStatus: Record<string, number>;
    modelRequests: number;
    inputTokens: number;
    outputTokens: number;
    /** replied / (runs that reached a verdict: all except running, skipped, superseded). null when there are none. */
    replyRate: number | null;
  };
  escalations: { opened: number; resolved: number; openNow: number; avgResolutionSeconds: number | null };
  orderDrafts: { byStatus: Record<string, number>; approved: Array<{ currency: string; count: number; totalMinor: number }> };
  /**
   * P8 funnel: conversations with a customer message in the period, then distinct orders whose `order_events` show a move
   * into each status in the period. Cash-on-delivery orders never pass `paid`, so `paid` counts prepaid orders only.
   */
  funnel: { conversations: number; drafts: number; approved: number; paid: number; shipped: number; delivered: number };
  /** P8, from `order_events`: drafts by creator, approvals by the draft's creator and by who approved (member or `auto_confirm`). */
  orderSources: { drafts: { ai: number; human: number }; approved: { ai: number; human: number }; approvedBy: { human: number; auto: number } };
  /** The shop's default currency: `daily[].revenueMinor` counts approved orders in it only. */
  currency: string;
  /**
   * Every UTC day the period touches, oldest first, zeros included (P10). AI runs by creation day; `newCustomers`,
   * `outgoingHuman` (not failed) by creation day; `approved` = distinct orders moved to `approved` that day (as the
   * funnel); `revenueMinor` = totals of orders whose `approved_at` falls on that day, in `currency`.
   */
  daily: Array<{
    date: string;
    runs: number;
    replied: number;
    escalated: number;
    inputTokens: number;
    outputTokens: number;
    newCustomers: number;
    outgoingHuman: number;
    approved: number;
    revenueMinor: number;
  }>;
};

/** `YYYY-MM-DD` of every UTC day from the day of `from` to the day of the last instant before `to`. */
function utcDays(period: StatsPeriod): string[] {
  const out: string[] = [];
  const last = new Date(new Date(period.to).getTime() - 1).toISOString().slice(0, 10);
  for (let d = new Date(`${period.from.slice(0, 10)}T00:00:00.000Z`); ; d = new Date(d.getTime() + DAY_MS)) {
    const k = d.toISOString().slice(0, 10);
    out.push(k);
    if (k >= last) return out;
  }
}

/**
 * Read-only, shop-scoped AI activity statistics (Feature 9), computed from existing tables. Every query filters by
 * `shop_id` and a half-open period `[from, to)` on the row's creation time (ISO-8601 UTC strings sort as text).
 * Internal: no authorization here.
 */
export class StatsRepository {
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Defaults: `to` = now, `from` = 30 days before `to`. Rejects an empty or longer-than-366-day period. */
  resolvePeriod(input: z.input<typeof periodInput> = {}): StatsPeriod {
    const r = periodInput.safeParse(input);
    if (!r.success) throw new StatsValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
    const to = r.data.to ? new Date(r.data.to) : this.clock();
    const from = r.data.from ? new Date(r.data.from) : new Date(to.getTime() - DEFAULT_DAYS * DAY_MS);
    if (from.getTime() >= to.getTime()) throw new StatsValidationError(['from: must be before to']);
    if (to.getTime() - from.getTime() > MAX_DAYS * DAY_MS) throw new StatsValidationError([`period: at most ${MAX_DAYS} days`]);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  async forShop(shopId: string, input: z.input<typeof periodInput> = {}): Promise<ShopStats> {
    const period = this.resolvePeriod(input);
    const db = this.handle.db;
    const { from, to } = period;
    const all = <T>(q: SQL) => queryRows<T>(db, q);
    const one = <T>(q: SQL) => queryRow<T>(db, q) as T;

    const msgRows = all<{ sender_type: string; delivery_status: string; n: number }>(
      sql`select sender_type, delivery_status, count(*) n from shop_messages
       where shop_id = ${shopId} and created_at >= ${from} and created_at < ${to} group by sender_type, delivery_status`,
    );
    const sent = (who: string) => msgRows.filter((r) => r.sender_type === who && r.delivery_status !== 'failed').reduce((a, r) => a + r.n, 0);
    const msgActive = one<{ n: number }>(
      sql`select count(distinct conversation_id) n from shop_messages where shop_id = ${shopId} and created_at >= ${from} and created_at < ${to}`,
    ).n;

    const runRows = all<{ status: string; n: number; req: number; inp: number; out: number }>(
      sql`select status, count(*) n, sum(model_requests) req, sum(input_tokens) inp, sum(output_tokens) as "out" from ai_runs
       where shop_id = ${shopId} and created_at >= ${from} and created_at < ${to} group by status`,
    );
    const byStatus = Object.fromEntries(runRows.map((r) => [r.status, r.n]));
    const verdicts = runRows.filter((r) => !['running', 'skipped', 'superseded'].includes(r.status)).reduce((a, r) => a + r.n, 0);

    const esc = one<{ opened: number }>(sql`select count(*) opened from escalations where shop_id = ${shopId} and created_at >= ${from} and created_at < ${to}`);
    const resolved = one<{ n: number; avg: number | null }>(
      sql`select count(*) n, avg(${secondsBetween(sql`created_at`, sql`resolved_at`)}) avg from escalations
       where shop_id = ${shopId} and status = 'resolved' and resolved_at >= ${from} and resolved_at < ${to}`,
    );
    const openNow = one<{ n: number }>(sql`select count(*) n from escalations where shop_id = ${shopId} and status = 'open'`).n;

    const drafts = all<{ status: string; n: number }>(
      sql`select status, count(*) n from order_drafts where shop_id = ${shopId} and created_at >= ${from} and created_at < ${to} group by status`,
    );
    const approved = all<{ currency: string; n: number; total: number }>(
      sql`select currency, count(*) n, sum(total_minor) total from order_drafts
       where shop_id = ${shopId} and approved_at >= ${from} and approved_at < ${to} group by currency order by currency`,
    );

    const currency = one<{ c: string } | undefined>(sql`select default_currency c from shops where id = ${shopId}`)?.c ?? 'UAH';
    const runDays = all<{ d: string; runs: number; replied: number; escalated: number; inp: number; out: number }>(
      sql`select substr(created_at, 1, 10) d, count(*) runs,
              sum(case when status = 'replied' then 1 else 0 end) replied, sum(case when status = 'escalated' then 1 else 0 end) escalated,
              sum(input_tokens) inp, sum(output_tokens) as "out"
       from ai_runs where shop_id = ${shopId} and created_at >= ${from} and created_at < ${to} group by d order by d`,
    );
    const byDay = <T extends { d: string }>(rows: T[]) => new Map(rows.map((r) => [r.d, r]));
    const runsBy = byDay(runDays);
    const custBy = byDay(
      all<{ d: string; n: number }>(
        sql`select substr(created_at, 1, 10) d, count(*) n from customers where shop_id = ${shopId} and created_at >= ${from} and created_at < ${to} group by d`,
      ),
    );
    const humanBy = byDay(
      all<{ d: string; n: number }>(
        sql`select substr(created_at, 1, 10) d, count(*) n from shop_messages
         where shop_id = ${shopId} and sender_type = 'human' and delivery_status <> 'failed' and created_at >= ${from} and created_at < ${to} group by d`,
      ),
    );
    const apprBy = byDay(
      all<{ d: string; n: number }>(
        sql`select substr(created_at, 1, 10) d, count(distinct draft_id) n from order_events
         where shop_id = ${shopId} and to_status = 'approved' and created_at >= ${from} and created_at < ${to} group by d`,
      ),
    );
    const revBy = byDay(
      all<{ d: string; n: number }>(
        sql`select substr(approved_at, 1, 10) d, sum(total_minor) n from order_drafts
           where shop_id = ${shopId} and currency = ${currency} and approved_at >= ${from} and approved_at < ${to} group by d`,
      ),
    );
    const daily = utcDays(period).map((date) => {
      const r = runsBy.get(date);
      return {
        date,
        runs: r?.runs ?? 0,
        replied: r?.replied ?? 0,
        escalated: r?.escalated ?? 0,
        inputTokens: r?.inp ?? 0,
        outputTokens: r?.out ?? 0,
        newCustomers: custBy.get(date)?.n ?? 0,
        outgoingHuman: humanBy.get(date)?.n ?? 0,
        approved: apprBy.get(date)?.n ?? 0,
        revenueMinor: revBy.get(date)?.n ?? 0,
      };
    });

    const stages = Object.fromEntries(
      all<{ to_status: string; n: number }>(
        sql`select to_status, count(distinct draft_id) n from order_events
         where shop_id = ${shopId} and created_at >= ${from} and created_at < ${to} and to_status in ('pending_approval', 'approved', 'paid', 'shipped', 'delivered')
         group by to_status`,
      ).map((r) => [r.to_status, r.n]),
    );
    const created = all<{ actor: string; n: number }>(
      sql`select actor, count(distinct draft_id) n from order_events
       where shop_id = ${shopId} and created_at >= ${from} and created_at < ${to} and from_status is null and to_status = 'pending_approval' group by actor`,
    );
    const approvals = all<{ created_by: string; auto: number; n: number }>(
      sql`select d.created_by, case when e.actor = 'system:auto_confirm' then 1 else 0 end as auto, count(distinct e.draft_id) n
       from order_events e join order_drafts d on d.id = e.draft_id and d.shop_id = e.shop_id
       where e.shop_id = ${shopId} and e.created_at >= ${from} and e.created_at < ${to} and e.to_status = 'approved'
       group by d.created_by, auto`,
    );
    const sum = <T extends { n: number }>(rows: T[], pick: (r: T) => boolean) => rows.filter(pick).reduce((a, r) => a + r.n, 0);

    return {
      period,
      messages: {
        incoming: msgRows.filter((r) => r.sender_type === 'customer').reduce((a, r) => a + r.n, 0),
        outgoingAi: sent('ai'),
        outgoingHuman: sent('human'),
        outgoingSystem: sent('system'),
        failedOutgoing: msgRows.filter((r) => r.sender_type !== 'customer' && r.delivery_status === 'failed').reduce((a, r) => a + r.n, 0),
      },
      conversations: {
        active: msgActive,
        newCustomers: one<{ n: number }>(sql`select count(*) n from customers where shop_id = ${shopId} and created_at >= ${from} and created_at < ${to}`).n,
        aiPausedNow: one<{ n: number }>(sql`select count(*) n from shop_conversations where shop_id = ${shopId} and ai_paused = true`).n,
      },
      ai: {
        runs: runRows.reduce((a, r) => a + r.n, 0),
        byStatus,
        modelRequests: runRows.reduce((a, r) => a + (r.req ?? 0), 0),
        inputTokens: runRows.reduce((a, r) => a + (r.inp ?? 0), 0),
        outputTokens: runRows.reduce((a, r) => a + (r.out ?? 0), 0),
        replyRate: verdicts ? (byStatus.replied ?? 0) / verdicts : null,
      },
      escalations: { opened: esc.opened, resolved: resolved.n, openNow, avgResolutionSeconds: resolved.avg === null ? null : Math.round(resolved.avg) },
      orderDrafts: {
        byStatus: Object.fromEntries(drafts.map((r) => [r.status, r.n])),
        approved: approved.map((r) => ({ currency: r.currency, count: r.n, totalMinor: r.total })),
      },
      funnel: {
        conversations: one<{ n: number }>(
          sql`select count(distinct conversation_id) n from shop_messages where shop_id = ${shopId} and direction = 'incoming' and created_at >= ${from} and created_at < ${to}`,
        ).n,
        drafts: stages.pending_approval ?? 0,
        approved: stages.approved ?? 0,
        paid: stages.paid ?? 0,
        shipped: stages.shipped ?? 0,
        delivered: stages.delivered ?? 0,
      },
      orderSources: {
        drafts: { ai: sum(created, (r) => r.actor === 'ai'), human: sum(created, (r) => r.actor !== 'ai') },
        approved: { ai: sum(approvals, (r) => r.created_by === 'ai'), human: sum(approvals, (r) => r.created_by !== 'ai') },
        approvedBy: { human: sum(approvals, (r) => !r.auto), auto: sum(approvals, (r) => !!r.auto) },
      },
      currency,
      daily,
    };
  }
}
