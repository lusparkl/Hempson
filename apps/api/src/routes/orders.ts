import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import {
  OrderNotFoundError,
  OrderStateError,
  OrderStockError,
  OrderValidationError,
  type AuthRepository,
  type OrderDraft,
  type OrderRepository,
  type ShopRepository,
} from '@hepson/database';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const draftP = z.object({ shopId: z.uuid(), draftId: z.uuid() });
const listQuery = z.object({
  status: z.enum(['pending_approval', 'approved', 'rejected', 'cancelled']).optional(),
  conversationId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const decisionBody = z.strictObject({ note: z.string().max(500).optional() });

const draftView = ({ draft: d, items }: OrderDraft) => ({
  draftId: d.id,
  conversationId: d.conversationId,
  customerId: d.customerId,
  status: d.status,
  createdBy: d.createdBy,
  runId: d.runId,
  contactName: d.contactName,
  contactPhone: d.contactPhone,
  deliveryInfo: d.deliveryInfo,
  note: d.note,
  currency: d.currency,
  totalMinor: d.totalMinor,
  decidedByUserId: d.decidedByUserId,
  decidedAt: d.decidedAt,
  decisionNote: d.decisionNote,
  createdAt: d.createdAt,
  items: items.map((i) => ({ productId: i.productId, variantId: i.variantId, sku: i.sku, productName: i.productName, options: i.options, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor })),
});

function translate(e: unknown): never {
  if (e instanceof OrderNotFoundError) throw new ConnectorError('NOT_FOUND', e.message);
  if (e instanceof OrderValidationError || e instanceof OrderStateError || e instanceof OrderStockError) throw new ConnectorError('VALIDATION_ERROR', e.message);
  throw e;
}

/**
 * Order drafts are created by the AI agent only; members review them. Approve and reject are explicit human decisions
 * (any member: owner or manager). Approving reduces stock atomically and fails whole if stock no longer covers it.
 */
export function registerOrderRoutes(app: FastifyInstance, deps: { shops: ShopRepository; auth: AuthRepository; orders: OrderRepository }) {
  const { shops, auth, orders } = deps;
  const requireRole = makeRequireRole(shops, auth);

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/order-drafts',
    summary: 'List order drafts, newest first (any member)',
    tag: 'orders',
    auth: 'user',
    params: shopP,
    query: listQuery,
    handler: ({ req, params, query }) => {
      requireRole(req, params.shopId, 'manager');
      const r = orders.listDrafts(params.shopId, query);
      return { total: r.total, items: r.items.map(draftView) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/order-drafts/:draftId',
    summary: 'Get an order draft with its items (any member)',
    tag: 'orders',
    auth: 'user',
    params: draftP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      const d = orders.getDraft(params.shopId, params.draftId);
      if (!d) throw new ConnectorError('NOT_FOUND', 'order draft not found');
      return draftView(d);
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/shops/:shopId/order-drafts/:draftId/approve',
    summary: 'Approve a pending draft: reduces stock for every line, or fails without change (any member)',
    tag: 'orders',
    auth: 'user',
    params: draftP,
    body: decisionBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'manager');
      try {
        return draftView(orders.approve(params.shopId, params.draftId, req.user!.user.id, body.note));
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/shops/:shopId/order-drafts/:draftId/reject',
    summary: 'Reject a pending draft (any member)',
    tag: 'orders',
    auth: 'user',
    params: draftP,
    body: decisionBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'manager');
      try {
        return draftView(orders.reject(params.shopId, params.draftId, req.user!.user.id, body.note));
      } catch (e) {
        translate(e);
      }
    },
  });
}
