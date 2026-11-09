import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import { queryRow } from './dialect';
import { PLAN_NAMES, PLANS } from './order-kinds';
import * as t from './schema';

export { PLANS, PLAN_NAMES } from './order-kinds';
export type PlanName = keyof typeof PLANS;
export type ShopPlan = { plan: PlanName; customCap: number | null; aiReplyCap: number | null; paidUntil: string | null; updatedAt: string | null };
export type AiUsage = {
  plan: PlanName;
  aiReplyCap: number | null;
  /** Last paid day (Kyiv date `YYYY-MM-DD`, inclusive); null = no expiry. `paidDaysLeft` is 0 on that day, negative after it. */
  paidUntil: string | null;
  paidDaysLeft: number | null;
  planExpired: boolean;
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

/** `plan` sets the plan and its custom cap together. `paidUntil` alone renews without touching them; absent keeps it, null clears it. */
export const planInput = z
  .strictObject({
    plan: z.enum(PLAN_NAMES).optional(),
    customCap: z.number().int().min(0).max(1_000_000).nullable().optional(),
    paidUntil: z.iso.date().nullable().optional(),
  })
  .refine((v) => v.plan !== undefined || (v.paidUntil !== undefined && v.customCap === undefined), 'Send plan (with an optional customCap), paidUntil, or both');

/** The Kyiv calendar date containing `d`, as `YYYY-MM-DD`. */
export function kyivDate(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

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

  async get(shopId: string): Promise<ShopPlan> {
    return this.getTx(shopId);
  }

  /** Sync body of `get`: runs inside the caller's transaction. Package-internal. */
  getTx(shopId: string): ShopPlan {
    const r = this.db.select().from(t.shopPlans).where(eq(t.shopPlans.shopId, shopId)).get();
    const plan = (r?.plan as PlanName | undefined) ?? this.defaultPlan;
    const customCap = r?.customCap ?? null;
    return { plan, customCap, aiReplyCap: customCap ?? PLANS[plan], paidUntil: r?.paidUntil ?? null, updatedAt: r?.updatedAt ?? null };
  }

  /** Operator only (the route checks the admin key). With `plan`, a `customCap` null or absent means the plan's own cap. */
  async set(shopId: string, input: z.input<typeof planInput>): Promise<ShopPlan> {
    const r = planInput.safeParse(input);
    if (!r.success) throw new PlanValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
    const { plan, customCap, paidUntil } = r.data;
    const row = { ...(plan ? { plan, customCap: customCap ?? null } : {}), ...(paidUntil !== undefined ? { paidUntil } : {}), updatedAt: this.now() };
    this.db
      .insert(t.shopPlans)
      .values({ shopId, plan: this.getTx(shopId).plan, customCap: null, capNoticeMonth: null, ...row })
      .onConflictDoUpdate({ target: t.shopPlans.shopId, set: row })
      .run();
    return this.getTx(shopId);
  }

  /** This UTC month's AI replies against the cap. `exceptRunId`: the run asking (already `running`) does not count itself. */
  async usage(shopId: string, exceptRunId?: string): Promise<AiUsage> {
    const p = this.getTx(shopId);
    const m = utcMonth(this.clock());
    const { n } = queryRow<{ n: number }>(
      this.db,
      sql`select count(*) n from ai_runs
         where shop_id = ${shopId} and created_at >= ${m.start} and created_at < ${m.end} and id != ${exceptRunId ?? ''}
           and (status = 'running' or (reply_message_id is not null and status in ('replied', 'send_uncertain', 'escalated')))`,
    )!;
    const paidDaysLeft = p.paidUntil === null ? null : (Date.parse(p.paidUntil) - Date.parse(kyivDate(this.clock()))) / 86_400_000;
    return {
      plan: p.plan,
      aiReplyCap: p.aiReplyCap,
      paidUntil: p.paidUntil,
      paidDaysLeft,
      planExpired: paidDaysLeft !== null && paidDaysLeft < 0,
      month: m.month,
      periodStart: m.start,
      periodEnd: m.end,
      aiReplies: n,
      remaining: p.aiReplyCap === null ? null : Math.max(p.aiReplyCap - n, 0),
      capReached: p.aiReplyCap !== null && n >= p.aiReplyCap,
    };
  }

  /** Claims the owner's cap notice for `month` (compare-and-set): true for exactly one caller per shop and month. */
  async claimCapNotice(shopId: string, month: string): Promise<boolean> {
    const r = this.db
      .insert(t.shopPlans)
      .values({ shopId, plan: this.getTx(shopId).plan, customCap: null, capNoticeMonth: month, updatedAt: this.now() })
      .onConflictDoUpdate({
        target: t.shopPlans.shopId,
        set: { capNoticeMonth: month },
        setWhere: sql`${t.shopPlans.capNoticeMonth} is null or ${t.shopPlans.capNoticeMonth} != ${month}`,
      })
      .run();
    return r.changes > 0;
  }

  /** Claims the owner's pause notice for this `paidUntil` (compare-and-set): true for exactly one caller per expiry. */
  async claimExpiryNotice(shopId: string, paidUntil: string): Promise<boolean> {
    const r = this.db
      .update(t.shopPlans)
      .set({ expiryNoticeFor: paidUntil })
      .where(and(eq(t.shopPlans.shopId, shopId), sql`(${t.shopPlans.expiryNoticeFor} is null or ${t.shopPlans.expiryNoticeFor} != ${paidUntil})`))
      .run();
    return r.changes > 0;
  }

  /** Claims every reminder now due, across shops: a last paid day within `withinDays` days, once per `paidUntil`. */
  async claimExpiryReminders(withinDays: number): Promise<Array<{ shopId: string; paidUntil: string }>> {
    const today = kyivDate(this.clock());
    const last = new Date(Date.parse(today) + withinDays * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db
      .update(t.shopPlans)
      .set({ expiryReminderFor: sql`${t.shopPlans.paidUntil}` })
      .where(
        and(
          gte(t.shopPlans.paidUntil, today),
          lte(t.shopPlans.paidUntil, last),
          sql`(${t.shopPlans.expiryReminderFor} is null or ${t.shopPlans.expiryReminderFor} != ${t.shopPlans.paidUntil})`,
        ),
      )
      .returning({ shopId: t.shopPlans.shopId, paidUntil: t.shopPlans.paidUntil })
      .all();
    return rows.map((r) => ({ shopId: r.shopId, paidUntil: r.paidUntil! }));
  }
}
