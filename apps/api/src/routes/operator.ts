import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors';
import type { AgentRepository, OperatorRepository, PlanRepository, ShopRepository } from '@hepson/database';
import type { AlertMonitor, RecentErrors } from '../services/alerts';
import type { Notifier } from '../services/notifier';
import { route } from './define';

const shopP = z.object({ shopId: z.uuid() });
const RUN_STATUSES = ['running', 'replied', 'send_uncertain', 'escalated', 'skipped', 'superseded', 'failed'] as const;
const runsQuery = z.object({
  shopId: z.uuid().optional(),
  status: z.enum(RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const stopBody = z.strictObject({ stopped: z.boolean(), reason: z.string().trim().max(300).optional() });

/** The operator panel (D50): every shop at a glance and the per-shop AI kill switch. Admin key only; no customer text or credentials. */
export function registerOperatorRoutes(
  app: FastifyInstance,
  deps: {
    shops: ShopRepository;
    agent: AgentRepository;
    plans: PlanRepository;
    operator: OperatorRepository;
    errors: RecentErrors;
    alerts: AlertMonitor | null;
    aiAvailable: boolean;
    notifier: Notifier | null;
  },
) {
  const { shops, agent, plans, operator, errors, alerts, aiAvailable, notifier } = deps;

  route(app, {
    method: 'GET',
    url: '/v1/operator/shops',
    summary: 'Every shop with its plan usage, AI state, channel status and recent failures (admin key)',
    tag: 'operator',
    auth: 'admin',
    handler: async () => {
      const list = await operator.listShops();
      return { aiAvailable, shops: await Promise.all(list.map(async (s) => ({ ...s, usage: await plans.usage(s.shopId) }))) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/operator/runs',
    summary: 'AI runs across all shops, newest first (admin key)',
    tag: 'operator',
    auth: 'admin',
    query: runsQuery,
    handler: async ({ query: { status, ...rest } }) => await operator.listRuns({ ...rest, statuses: status ? [status] : undefined }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/operator/errors',
    summary: 'What is down now, the latest server errors (since the last restart) and the latest failed AI runs (admin key)',
    tag: 'operator',
    auth: 'admin',
    handler: async () => ({
      alertsConfigured: alerts !== null,
      incidents: alerts?.incidents() ?? [],
      events: errors.list(),
      failedRuns: (await operator.listRuns({ statuses: ['failed', 'send_uncertain'], limit: 20 })).items,
    }),
  });

  route(app, {
    method: 'PUT',
    url: '/v1/operator/shops/:shopId/ai-stop',
    summary: "Kill switch: stop or resume the shop's AI whatever its owner set. Takes effect on runs in flight; tells the owner in Telegram, never the customers (admin key)",
    tag: 'operator',
    auth: 'admin',
    params: shopP,
    body: stopBody,
    handler: async ({ req, params, body, principal }) => {
      if (!(await shops.get(params.shopId))) throw new ApiError('NOT_FOUND', 'Shop not found');
      const { settings: s, changed } = await agent.setOperatorStop(params.shopId, body.stopped, body.reason || null);
      if (changed) notifier?.notify({ kind: body.stopped ? 'ai_stopped' : 'ai_resumed', shopId: params.shopId });
      req.log.info({ shopId: params.shopId, keyId: principal!.keyId, stopped: body.stopped }, 'operator AI stop changed');
      return { stopped: s.operatorStoppedAt !== null, stoppedAt: s.operatorStoppedAt, reason: s.operatorStopReason };
    },
  });
}
