import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import { PLAN_NAMES, PLANS } from './order-kinds';
import * as t from './schema';

export { PLANS, PLAN_NAMES } from './order-kinds';
export type PlanName = keyof typeof PLANS;
export type ShopPlan = { plan: PlanName; customCap: number | null; aiReplyCap: number | null; updatedAt: string | null };
export type AiUsage = {
  plan: PlanName;
  aiReplyCap: number | null;
  /** UTC calendar month `YYYY-MM` and its bounds [periodStart, periodEnd). */
  month: string;
  periodStart: string;
  periodEnd: string;
  aiReplies: number;
  remaining: number | null;
  capReached: boolean;
};

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

const planInput = z.strictObject({ plan: z.enum(PLAN_NAMES), customCap: z.number().int().min(0).max(1_000_000).nullable().optional() });

/** The UTC calendar month containing `d`. */
export function utcMonth(d: Date): { month: string; start: string; end: string } {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return { month: `${y}-${String(m + 1).padStart(2, '0')}`, start: new Date(Date.UTC(y, m, 1)).toISOString(), end: new Date(Date.UTC(y, m + 1, 1)).toISOString() };
}

/**
 * Plans and the monthly AI-reply quota (P7). Usage is derived from `ai_runs`, never kept as a counter: an AI reply is a
 * run whose reply was sent or may have been sent (`replied`, `send_uncertain`, or `escalated` with a reply message).
 * Runs still `running` are counted too, so runs in flight at the same time cannot overshoot the cap.
 */
export class PlanRepository {
  readonly db: Db;
  constructor(
    private readonly handle: DbHandle,
    private readonly defaultPlan: PlanName = 'starter',
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }
  private now() {
    return this.clock().toISOString();
  }

  get(shopId: string): ShopPlan {
    const r = this.db.select().from(t.shopPlans).where(eq(t.shopPlans.shopId, shopId)).get();
    const plan = (r?.plan as PlanName | undefined) ?? this.defaultPlan;
    const customCap = r?.customCap ?? null;
    return { plan, customCap, aiReplyCap: customCap ?? PLANS[plan], updatedAt: r?.updatedAt ?? null };
  }

  /** Operator only (the route checks the admin key). `customCap` null or absent means the plan's own cap. */
  set(shopId: string, input: z.input<typeof planInput>): ShopPlan {
    const r = planInput.safeParse(input);
    if (!r.success) throw new PlanValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
    const row = { plan: r.data.plan, customCap: r.data.customCap ?? null, updatedAt: this.now() };
    this.db
      .insert(t.shopPlans)
      .values({ shopId, ...row, capNoticeMonth: null })
      .onConflictDoUpdate({ target: t.shopPlans.shopId, set: row })
      .run();
    return this.get(shopId);
  }

  /** This UTC month's AI replies against the cap. `exceptRunId`: the run asking (already `running`) does not count itself. */
  usage(shopId: string, exceptRunId?: string): AiUsage {
    const p = this.get(shopId);
    const m = utcMonth(this.clock());
    const { n } = this.handle.raw
      .prepare(
        `select count(*) n from ai_runs
         where shop_id = ? and created_at >= ? and created_at < ? and id != ?
           and (status = 'running' or (reply_message_id is not null and status in ('replied', 'send_uncertain', 'escalated')))`,
      )
      .get(shopId, m.start, m.end, exceptRunId ?? '') as { n: number };
    return {
      plan: p.plan,
      aiReplyCap: p.aiReplyCap,
      month: m.month,
      periodStart: m.start,
      periodEnd: m.end,
      aiReplies: n,
      remaining: p.aiReplyCap === null ? null : Math.max(p.aiReplyCap - n, 0),
      capReached: p.aiReplyCap !== null && n >= p.aiReplyCap,
    };
  }

  /** Claims the owner's cap notice for `month` (compare-and-set): true for exactly one caller per shop and month. */
  claimCapNotice(shopId: string, month: string): boolean {
    const r = this.db
      .insert(t.shopPlans)
      .values({ shopId, plan: this.get(shopId).plan, customCap: null, capNoticeMonth: month, updatedAt: this.now() })
      .onConflictDoUpdate({
        target: t.shopPlans.shopId,
        set: { capNoticeMonth: month },
        setWhere: sql`${t.shopPlans.capNoticeMonth} is null or ${t.shopPlans.capNoticeMonth} != ${month}`,
      })
      .run();
    return r.changes > 0;
  }
}
