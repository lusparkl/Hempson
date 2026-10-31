import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import { POLICY_TOPICS } from './order-kinds';
import * as t from './schema';

export { POLICY_TOPICS };
export type PolicyTopic = (typeof POLICY_TOPICS)[number];
export type PolicyRow = typeof t.shopPolicies.$inferSelect;

export class PolicyValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid policy: ${issues.join('; ')}`);
    this.name = 'PolicyValidationError';
  }
}

const policyText = z.string().trim().max(4000);

/**
 * Shop policy texts (P3): delivery, returns, payment, opening hours. The agent quotes them through `get_policy`; the
 * reply guard accepts a policy claim only if the text returned in the same run backs it. Empty text = no policy.
 * Every method takes `shopId` first and filters by it. Internal: no authorization here.
 */
export class PolicyRepository {
  readonly db: Db;
  constructor(
    handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }

  list(shopId: string): PolicyRow[] {
    const rows = this.db.select().from(t.shopPolicies).where(eq(t.shopPolicies.shopId, shopId)).all();
    return POLICY_TOPICS.map((topic) => rows.find((r) => r.topic === topic) ?? { shopId, topic, text: '', version: 0, updatedByUserId: null, updatedAt: '' });
  }

  /** The stored text, or undefined when the shop has no text for this topic. */
  get(shopId: string, topic: PolicyTopic): PolicyRow | undefined {
    const r = this.db
      .select()
      .from(t.shopPolicies)
      .where(and(eq(t.shopPolicies.shopId, shopId), eq(t.shopPolicies.topic, topic)))
      .get();
    return r?.text ? r : undefined;
  }

  /** Saves a new version (an empty text clears the policy; the version still grows). */
  save(shopId: string, topic: PolicyTopic, text: string, userId: string | null): PolicyRow {
    const r = policyText.safeParse(text);
    if (!r.success) throw new PolicyValidationError(['text: at most 4000 characters']);
    const cur = this.db
      .select({ version: t.shopPolicies.version })
      .from(t.shopPolicies)
      .where(and(eq(t.shopPolicies.shopId, shopId), eq(t.shopPolicies.topic, topic)))
      .get();
    const row: PolicyRow = { shopId, topic, text: r.data, version: (cur?.version ?? 0) + 1, updatedByUserId: userId, updatedAt: this.clock().toISOString() };
    this.db
      .insert(t.shopPolicies)
      .values(row)
      .onConflictDoUpdate({ target: [t.shopPolicies.shopId, t.shopPolicies.topic], set: { text: row.text, version: row.version, updatedByUserId: userId, updatedAt: row.updatedAt } })
      .run();
    return row;
  }
}
