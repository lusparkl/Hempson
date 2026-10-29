import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import { StatsValidationError, type AuthRepository, type ShopRepository, type StatsRepository } from '@hepson/database';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const statsQuery = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() });

/** AI activity statistics of one shop (any member). Period is [from, to), default the last 30 days, at most 366 days. */
export function registerStatsRoutes(app: FastifyInstance, deps: { shops: ShopRepository; auth: AuthRepository; stats: StatsRepository }) {
  const { shops, auth, stats } = deps;
  const requireRole = makeRequireRole(shops, auth);

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/stats',
    summary: 'AI activity statistics: messages, agent runs and tokens, escalations, order drafts, daily series (any member)',
    tag: 'stats',
    auth: 'user',
    params: shopP,
    query: statsQuery,
    handler: ({ req, params, query }) => {
      requireRole(req, params.shopId, 'manager');
      try {
        return stats.forShop(params.shopId, query);
      } catch (e) {
        if (e instanceof StatsValidationError) throw new ConnectorError('VALIDATION_ERROR', e.message);
        throw e;
      }
    },
  });
}
