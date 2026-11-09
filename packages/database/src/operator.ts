import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db, DbHandle } from './db';
import { queryRows } from './dialect';
import type { AiRunStatus } from './agent';
import { utcMonth } from './plans';
import * as t from './schema';

const DAY_MS = 86_400_000;

export type OperatorChannel = { connected: boolean; status: string; account: string | null; lastError: string | null };
export type OperatorShop = {
  shopId: string;
  name: string;
  slug: string;
  createdAt: string;
  ownerEmail: string | null;
  aiEnabled: boolean;
  operatorStoppedAt: string | null;
  operatorStopReason: string | null;
  channels: {
    instagram: (OperatorChannel & { tokenExpiresAt: string | null }) | null;
    telegram: OperatorChannel | null;
    website: boolean;
  };
  /** This UTC month. */
  tokens: { input: number; output: number; modelRequests: number };
  /** The last 24 hours. `failedRuns` = `failed` or `send_uncertain`; `failedSends` = outgoing messages `failed` or `uncertain`. */
  last24h: { runs: number; failedRuns: number; failedSends: number };
  lastRunAt: string | null;
  openEscalations: number;
};
export type OperatorRun = {
  runId: string;
  shopId: string;
  shopName: string;
  conversationId: string;
  status: AiRunStatus;
  detail: string | null;
  model: string | null;
  modelRequests: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  finishedAt: string | null;
};

type ShopRow = {
  shopId: string;
  name: string;
  slug: string;
  createdAt: string;
  ownerEmail: string | null;
  aiEnabled: unknown;
  stoppedAt: string | null;
  stopReason: string | null;
  igStatus: string | null;
  igUsername: string | null;
  igError: string | null;
  igExpires: string | null;
  tgStatus: string | null;
  tgUsername: string | null;
  tgError: string | null;
  webEnabled: unknown;
  inputTokens: number;
  outputTokens: number;
  modelRequests: number;
  runs: number;
  failedRuns: number;
  failedSends: number;
  lastRunAt: string | null;
  openEscalations: number;
};

/**
 * Read-only views across every shop for the operator panel (D50): the deliberate exception to shop-scoped queries, so it
 * stays behind the admin key. Holds no customer text and no credentials: run details and channel errors are short codes.
 */
export class OperatorRepository {
  readonly db: Db;
  constructor(
    handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }

  /** Newest shops first. Correlated subqueries, so each count uses that table's `(shop_id, created_at)` index. */
  async listShops(): Promise<OperatorShop[]> {
    const now = this.clock();
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const m = utcMonth(now);
    const monthly = (column: SQL) => sql`(select coalesce(sum(${column}), 0) from ai_runs r where r.shop_id = s.id and r.created_at >= ${m.start} and r.created_at < ${m.end})`;
    const rows = queryRows<ShopRow>(
      this.db,
      sql`select s.id as "shopId", s.name as "name", s.slug as "slug", s.created_at as "createdAt",
           (select u.email from memberships o join users u on u.id = o.user_id where o.shop_id = s.id and o.role = 'owner' order by o.created_at limit 1) as "ownerEmail",
           a.enabled as "aiEnabled", a.operator_stopped_at as "stoppedAt", a.operator_stop_reason as "stopReason",
           ig.status as "igStatus", ig.username as "igUsername", ig.last_error as "igError", ig.token_expires_at as "igExpires",
           tg.status as "tgStatus", tg.bot_username as "tgUsername", tg.last_error as "tgError",
           w.enabled as "webEnabled",
           ${monthly(sql`r.input_tokens`)} as "inputTokens",
           ${monthly(sql`r.output_tokens`)} as "outputTokens",
           ${monthly(sql`r.model_requests`)} as "modelRequests",
           (select count(*) from ai_runs r where r.shop_id = s.id and r.created_at >= ${since}) as "runs",
           (select count(*) from ai_runs r where r.shop_id = s.id and r.created_at >= ${since} and r.status in ('failed', 'send_uncertain')) as "failedRuns",
           (select count(*) from shop_messages x where x.shop_id = s.id and x.created_at >= ${since} and x.direction = 'outgoing' and x.delivery_status in ('failed', 'uncertain')) as "failedSends",
           (select max(r.created_at) from ai_runs r where r.shop_id = s.id) as "lastRunAt",
           (select count(*) from escalations e where e.shop_id = s.id and e.status = 'open') as "openEscalations"
         from shops s
         left join shop_ai_settings a on a.shop_id = s.id
         left join instagram_channels ig on ig.shop_id = s.id
         left join telegram_channels tg on tg.shop_id = s.id
         left join web_chat_configs w on w.shop_id = s.id
         order by s.created_at desc, s.id`,
    );
    return rows.map((r) => ({
      shopId: r.shopId,
      name: r.name,
      slug: r.slug,
      createdAt: r.createdAt,
      ownerEmail: r.ownerEmail,
      aiEnabled: !!r.aiEnabled,
      operatorStoppedAt: r.stoppedAt,
      operatorStopReason: r.stopReason,
      channels: {
        instagram: r.igStatus ? { connected: r.igStatus === 'connected', status: r.igStatus, account: r.igUsername, lastError: r.igError, tokenExpiresAt: r.igExpires } : null,
        telegram: r.tgStatus ? { connected: r.tgStatus === 'connected', status: r.tgStatus, account: r.tgUsername, lastError: r.tgError } : null,
        website: !!r.webEnabled,
      },
      tokens: { input: Number(r.inputTokens), output: Number(r.outputTokens), modelRequests: Number(r.modelRequests) },
      last24h: { runs: Number(r.runs), failedRuns: Number(r.failedRuns), failedSends: Number(r.failedSends) },
      lastRunAt: r.lastRunAt,
      openEscalations: Number(r.openEscalations),
    }));
  }

  /** Runs of every shop (or one), newest first. */
  async listRuns(f: { shopId?: string; statuses?: AiRunStatus[]; limit?: number; offset?: number } = {}): Promise<{ items: OperatorRun[]; total: number }> {
    const where = and(f.shopId ? eq(t.aiRuns.shopId, f.shopId) : undefined, f.statuses?.length ? inArray(t.aiRuns.status, f.statuses) : undefined);
    const total = this.db
      .select({ n: sql<number>`count(*)` })
      .from(t.aiRuns)
      .where(where)
      .get()!.n;
    const items = this.db
      .select({
        runId: t.aiRuns.id,
        shopId: t.aiRuns.shopId,
        shopName: t.shops.name,
        conversationId: t.aiRuns.conversationId,
        status: t.aiRuns.status,
        detail: t.aiRuns.detail,
        model: t.aiRuns.model,
        modelRequests: t.aiRuns.modelRequests,
        inputTokens: t.aiRuns.inputTokens,
        outputTokens: t.aiRuns.outputTokens,
        createdAt: t.aiRuns.createdAt,
        finishedAt: t.aiRuns.finishedAt,
      })
      .from(t.aiRuns)
      .innerJoin(t.shops, eq(t.shops.id, t.aiRuns.shopId))
      .where(where)
      .orderBy(desc(t.aiRuns.createdAt), desc(t.aiRuns.id))
      .limit(Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 200))
      .offset(Math.max(Math.trunc(f.offset ?? 0), 0))
      .all();
    return { items, total };
  }
}
