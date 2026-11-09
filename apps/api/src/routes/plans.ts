import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors';
import { PlanValidationError, planInput, type AuthRepository, type PlanRepository, type ShopRepository } from '@hepson/database';
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
    handler: async ({ req, params }) => {
      await requireRole(req, params.shopId, 'manager');
      return await plans.usage(params.shopId);
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/plan',
    summary: "Assign the shop's plan (optionally with a custom monthly AI-reply cap) and/or its last paid day (admin key)",
    tag: 'stats',
    auth: 'admin',
    params: shopP,
    body: planInput,
    handler: async ({ params, body }) => {
      if (!(await shops.get(params.shopId))) throw new ApiError('NOT_FOUND', 'Shop not found');
      try {
        await plans.set(params.shopId, body);
      } catch (e) {
        if (e instanceof PlanValidationError) throw new ApiError('VALIDATION_ERROR', e.message);
        throw e;
      }
      return await plans.usage(params.shopId);
    },
  });
}
