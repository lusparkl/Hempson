import { z } from 'zod';
import type { DbHandle } from './db';

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
  /** UTC days with at least one run, oldest first. */
  daily: Array<{ date: string; runs: number; replied: number; escalated: number; inputTokens: number; outputTokens: number }>;
};

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

  forShop(shopId: string, input: z.input<typeof periodInput> = {}): ShopStats {
    const period = this.resolvePeriod(input);
    const raw = this.handle.raw;
    const p = { shop: shopId, from: period.from, to: period.to };
    const all = <T>(sql: string) => raw.prepare(sql).all(p) as T[];
    const one = <T>(sql: string) => raw.prepare(sql).get(p) as T;

    const msgRows = all<{ sender_type: string; delivery_status: string; n: number }>(
      `select sender_type, delivery_status, count(*) n from shop_messages
       where shop_id = @shop and created_at >= @from and created_at < @to group by sender_type, delivery_status`,
    );
    const sent = (who: string) => msgRows.filter((r) => r.sender_type === who && r.delivery_status !== 'failed').reduce((a, r) => a + r.n, 0);
    const msgActive = one<{ n: number }>(
      `select count(distinct conversation_id) n from shop_messages where shop_id = @shop and created_at >= @from and created_at < @to`,
    ).n;

    const runRows = all<{ status: string; n: number; req: number; inp: number; out: number }>(
      `select status, count(*) n, sum(model_requests) req, sum(input_tokens) inp, sum(output_tokens) out from ai_runs
       where shop_id = @shop and created_at >= @from and created_at < @to group by status`,
    );
    const byStatus = Object.fromEntries(runRows.map((r) => [r.status, r.n]));
    const verdicts = runRows.filter((r) => !['running', 'skipped', 'superseded'].includes(r.status)).reduce((a, r) => a + r.n, 0);

    const esc = one<{ opened: number }>(`select count(*) opened from escalations where shop_id = @shop and created_at >= @from and created_at < @to`);
    const resolved = one<{ n: number; avg: number | null }>(
      `select count(*) n, avg((julianday(resolved_at) - julianday(created_at)) * 86400) avg from escalations
       where shop_id = @shop and status = 'resolved' and resolved_at >= @from and resolved_at < @to`,
    );
    const openNow = one<{ n: number }>(`select count(*) n from escalations where shop_id = @shop and status = 'open'`).n;

    const drafts = all<{ status: string; n: number }>(
      `select status, count(*) n from order_drafts where shop_id = @shop and created_at >= @from and created_at < @to group by status`,
    );
    const approved = all<{ currency: string; n: number; total: number }>(
      `select currency, count(*) n, sum(total_minor) total from order_drafts
       where shop_id = @shop and approved_at >= @from and approved_at < @to group by currency order by currency`,
    );

    const daily = all<{ d: string; runs: number; replied: number; escalated: number; inp: number; out: number }>(
      `select substr(created_at, 1, 10) d, count(*) runs,
              sum(status = 'replied') replied, sum(status = 'escalated') escalated,
              sum(input_tokens) inp, sum(output_tokens) out
       from ai_runs where shop_id = @shop and created_at >= @from and created_at < @to group by d order by d`,
    );

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
        newCustomers: one<{ n: number }>(`select count(*) n from customers where shop_id = @shop and created_at >= @from and created_at < @to`).n,
        aiPausedNow: one<{ n: number }>(`select count(*) n from shop_conversations where shop_id = @shop and ai_paused = 1`).n,
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
      daily: daily.map((r) => ({ date: r.d, runs: r.runs, replied: r.replied, escalated: r.escalated, inputTokens: r.inp ?? 0, outputTokens: r.out ?? 0 })),
    };
  }
}
