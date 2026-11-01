import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import { PLAN_NAMES, PlanValidationError, type AuthRepository, type PlanRepository, type ShopRepository } from '@hepson/database';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });

/** Plans and AI-reply usage (P7). Members see usage; only the operator (admin key) assigns a plan. No billing. */
export function registerPlanRoutes(app: FastifyInstance, deps: { shops: ShopRepository; auth: AuthRepository; plans: PlanRepository }) {
  const { shops, auth, plans } = deps;
  const requireRole = makeRequireRole(shops, auth);

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/usage',
    summary: "This UTC month's AI replies against the shop's plan cap (any member)",
    tag: 'stats',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      return plans.usage(params.shopId);
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/plan',
    summary: "Assign the shop's plan, optionally with a custom monthly AI-reply cap (admin key)",
    tag: 'stats',
    auth: 'admin',
    params: shopP,
    body: z.strictObject({ plan: z.enum(PLAN_NAMES), customCap: z.number().int().min(0).max(1_000_000).nullable().optional() }),
    handler: ({ params, body }) => {
      if (!shops.get(params.shopId)) throw new ConnectorError('NOT_FOUND', 'Shop not found');
      try {
        plans.set(params.shopId, body);
      } catch (e) {
        if (e instanceof PlanValidationError) throw new ConnectorError('VALIDATION_ERROR', e.message);
        throw e;
      }
      return plans.usage(params.shopId);
    },
  });
}
