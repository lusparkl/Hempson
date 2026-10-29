import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import * as t from './schema';

export type AiSettingsRow = typeof t.shopAiSettings.$inferSelect;
export type AiRunRow = typeof t.aiRuns.$inferSelect;
export type EscalationRow = typeof t.escalations.$inferSelect;
export type NotifySettingsRow = typeof t.shopNotifySettings.$inferSelect;
export type AiRunStatus = AiRunRow['status'];

export class AgentValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid agent input: ${issues.join('; ')}`);
    this.name = 'AgentValidationError';
  }
}
export class AgentNotFoundError extends Error {
  constructor(what: 'escalation' | 'run') {
    super(`${what} not found`);
    this.name = 'AgentNotFoundError';
  }
}

const settingsInput = z.strictObject({ enabled: z.boolean().optional(), instructions: z.string().max(2000).optional() });
const notifyInput = z.strictObject({
  telegramChatId: z
    .string()
    .trim()
    .regex(/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, 'numeric chat id or @channelname')
    .nullable(),
});
const reason = z.string().trim().min(1).max(500);

export type RunPatch = Partial<Pick<AiRunRow, 'status' | 'model' | 'modelRequests' | 'inputTokens' | 'outputTokens' | 'replyMessageId' | 'detail'>>;

/**
 * Shop-scoped AI settings, run audit and escalations (Feature 6). Every method takes `shopId` first and filters by it.
 * Internal: no authorization here.
 */
export class AgentRepository {
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

  /** AI is off until the owner enables it. */
  getSettings(shopId: string): AiSettingsRow {
    return this.db.select().from(t.shopAiSettings).where(eq(t.shopAiSettings.shopId, shopId)).get() ?? { shopId, enabled: false, instructions: '', updatedAt: '' };
  }

  updateSettings(shopId: string, input: z.input<typeof settingsInput>): AiSettingsRow {
    const r = settingsInput.safeParse(input);
    if (!r.success) throw new AgentValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
    const cur = this.getSettings(shopId);
    const row = { shopId, enabled: r.data.enabled ?? cur.enabled, instructions: r.data.instructions ?? cur.instructions, updatedAt: this.now() };
    this.db
      .insert(t.shopAiSettings)
      .values(row)
      .onConflictDoUpdate({ target: t.shopAiSettings.shopId, set: { enabled: row.enabled, instructions: row.instructions, updatedAt: row.updatedAt } })
      .run();
    return row;
  }

  getNotifySettings(shopId: string): NotifySettingsRow {
    return this.db.select().from(t.shopNotifySettings).where(eq(t.shopNotifySettings.shopId, shopId)).get() ?? { shopId, telegramChatId: null, updatedAt: '' };
  }

  updateNotifySettings(shopId: string, input: z.input<typeof notifyInput>): NotifySettingsRow {
    const r = notifyInput.safeParse(input);
    if (!r.success) throw new AgentValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
    const row = { shopId, telegramChatId: r.data.telegramChatId, updatedAt: this.now() };
    this.db
      .insert(t.shopNotifySettings)
      .values(row)
      .onConflictDoUpdate({ target: t.shopNotifySettings.shopId, set: { telegramChatId: row.telegramChatId, updatedAt: row.updatedAt } })
      .run();
    return row;
  }

  /** Claims the trigger message. Returns undefined when a run already exists for it (never answer one message twice). */
  startRun(shopId: string, conversationId: string, triggerMessageId: string): AiRunRow | undefined {
    const row: AiRunRow = {
      id: randomUUID(),
      shopId,
      conversationId,
      triggerMessageId,
      status: 'running',
      model: null,
      modelRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      replyMessageId: null,
      detail: null,
      createdAt: this.now(),
      finishedAt: null,
    };
    const r = this.db.insert(t.aiRuns).values(row).onConflictDoNothing().run();
    return r.changes ? row : undefined;
  }

  updateRun(shopId: string, runId: string, patch: RunPatch): AiRunRow {
    const finished = patch.status && patch.status !== 'running' ? { finishedAt: this.now() } : {};
    const r = this.db
      .update(t.aiRuns)
      .set({ ...patch, ...finished })
      .where(and(eq(t.aiRuns.shopId, shopId), eq(t.aiRuns.id, runId)))
      .returning()
      .get();
    if (!r) throw new AgentNotFoundError('run');
    return r;
  }

  getRun(shopId: string, runId: string): AiRunRow | undefined {
    return this.db
      .select()
      .from(t.aiRuns)
      .where(and(eq(t.aiRuns.shopId, shopId), eq(t.aiRuns.id, runId)))
      .get();
  }

  /** Runs left `running` by a crash can never finish: mark them failed at boot. */
  failInterruptedRuns(): number {
    return this.db
      .update(t.aiRuns)
      .set({ status: 'failed', detail: 'INTERRUPTED', finishedAt: this.now() })
      .where(eq(t.aiRuns.status, 'running'))
      .run().changes;
  }

  listRuns(shopId: string, f: { conversationId?: string; limit?: number; offset?: number } = {}): { items: AiRunRow[]; total: number } {
    const conds = [eq(t.aiRuns.shopId, shopId)];
    if (f.conversationId) conds.push(eq(t.aiRuns.conversationId, f.conversationId));
    const where = and(...conds);
    const total = this.db.select({ n: sql<number>`count(*)` }).from(t.aiRuns).where(where).get()!.n;
    const items = this.db
      .select()
      .from(t.aiRuns)
      .where(where)
      .orderBy(desc(t.aiRuns.createdAt), desc(t.aiRuns.id))
      .limit(Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 200))
      .offset(Math.max(Math.trunc(f.offset ?? 0), 0))
      .all();
    return { items, total };
  }

  /** Opens an escalation unless one is already open for the conversation (then returns that one). */
  escalate(shopId: string, conversationId: string, text: string, runId?: string): { escalation: EscalationRow; created: boolean } {
    const why = reason.safeParse(text);
    if (!why.success) throw new AgentValidationError(['reason: 1-500 characters required']);
    return this.handle.raw.transaction(() => {
      const open = this.openEscalation(shopId, conversationId);
      if (open) return { escalation: open, created: false };
      const row: EscalationRow = {
        id: randomUUID(),
        shopId,
        conversationId,
        runId: runId ?? null,
        reason: why.data,
        status: 'open',
        createdAt: this.now(),
        resolvedAt: null,
        resolvedByUserId: null,
      };
      this.db.insert(t.escalations).values(row).run();
      return { escalation: row, created: true };
    })();
  }

  openEscalation(shopId: string, conversationId: string): EscalationRow | undefined {
    return this.db
      .select()
      .from(t.escalations)
      .where(and(eq(t.escalations.shopId, shopId), eq(t.escalations.conversationId, conversationId), eq(t.escalations.status, 'open')))
      .get();
  }

  listEscalations(shopId: string, f: { status?: EscalationRow['status']; limit?: number; offset?: number } = {}): { items: EscalationRow[]; total: number } {
    const conds = [eq(t.escalations.shopId, shopId)];
    if (f.status) conds.push(eq(t.escalations.status, f.status));
    const where = and(...conds);
    const total = this.db.select({ n: sql<number>`count(*)` }).from(t.escalations).where(where).get()!.n;
    const items = this.db
      .select()
      .from(t.escalations)
      .where(where)
      .orderBy(desc(t.escalations.createdAt), desc(t.escalations.id))
      .limit(Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 200))
      .offset(Math.max(Math.trunc(f.offset ?? 0), 0))
      .all();
    return { items, total };
  }

  /** Idempotent: resolving an already resolved escalation returns it unchanged. */
  resolveEscalation(shopId: string, escalationId: string, userId: string | null): EscalationRow {
    const cur = this.db
      .select()
      .from(t.escalations)
      .where(and(eq(t.escalations.shopId, shopId), eq(t.escalations.id, escalationId)))
      .get();
    if (!cur) throw new AgentNotFoundError('escalation');
    if (cur.status === 'resolved') return cur;
    return this.db
      .update(t.escalations)
      .set({ status: 'resolved', resolvedAt: this.now(), resolvedByUserId: userId })
      .where(eq(t.escalations.id, cur.id))
      .returning()
      .get()!;
  }
}
