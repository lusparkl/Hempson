import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import { POLICY_TOPICS, PolicyValidationError, type AuthRepository, type PolicyRepository, type PolicyRow, type ShopRepository } from '@hepson/database';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const topicP = z.object({ shopId: z.uuid(), topic: z.enum(POLICY_TOPICS) });
const body = z.strictObject({ text: z.string() });

const view = (p: PolicyRow) => ({ topic: p.topic, text: p.text, version: p.version, updatedAt: p.updatedAt || null, updatedByUserId: p.updatedByUserId });

/** Shop policy texts the agent quotes through `get_policy` (P3): any member reads, only the owner edits. */
export function registerPolicyRoutes(app: FastifyInstance, deps: { shops: ShopRepository; auth: AuthRepository; policies: PolicyRepository }) {
  const { shops, auth, policies } = deps;
  const requireRole = makeRequireRole(shops, auth);

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/policies',
    summary: 'Delivery, returns, payment and opening-hours texts (any member). Empty text = the agent escalates instead of answering',
    tag: 'policies',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      return { items: policies.list(params.shopId).map(view) };
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/policies/:topic',
    summary: 'Save one policy text as a new version (owner). Up to 4000 characters; empty clears it',
    tag: 'policies',
    auth: 'user',
    params: topicP,
    body,
    handler: ({ req, params, body: b }) => {
      requireRole(req, params.shopId, 'owner');
      try {
        return view(policies.save(params.shopId, params.topic, b.text, req.user!.user.id));
      } catch (e) {
        if (e instanceof PolicyValidationError) throw new ConnectorError('VALIDATION_ERROR', e.message);
        throw e;
      }
    },
  });
}
