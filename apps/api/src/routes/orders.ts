import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import {
  ORDER_STATUSES,
  OrderNotFoundError,
  OrderStateError,
  OrderStockError,
  OrderValidationError,
  checkoutMissing,
  type AuthRepository,
  type OrderDraft,
  type OrderEventRow,
  type OrderRepository,
  type ShopRepository,
} from '@hepson/database';
import type { DeliveryService } from '../services/delivery';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const draftP = z.object({ shopId: z.uuid(), draftId: z.uuid() });
const listQuery = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  conversationId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const decisionBody = z.strictObject({ note: z.string().max(500).optional() });
const returnedBody = z.strictObject({ restock: z.boolean().optional(), note: z.string().max(500).optional() });

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
  approvedAt: d.approvedAt,
  checkout: {
    firstName: d.recipientFirstName,
    lastName: d.recipientLastName,
    phone: d.recipientPhone,
    cityRef: d.npCityRef,
    cityName: d.npCityName,
    branchRef: d.npWarehouseRef,
    branchName: d.npWarehouseName,
    paymentMethod: d.paymentMethod,
    missing: checkoutMissing(d),
  },
  delivery: { ttnState: d.ttnState, ttnError: d.ttnError, ttn: d.ttn, statusCode: d.npStatusCode, statusText: d.npStatusText, statusAt: d.npStatusAt },
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  items: items.map((i) => ({ productId: i.productId, variantId: i.variantId, sku: i.sku, productName: i.productName, options: i.options, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor })),
});

const eventView = (e: OrderEventRow) => ({ from: e.fromStatus, to: e.toStatus, actor: e.actor, note: e.note, at: e.createdAt });

function translate(e: unknown): never {
  if (e instanceof OrderNotFoundError) throw new ConnectorError('NOT_FOUND', e.message);
  if (e instanceof OrderValidationError || e instanceof OrderStateError || e instanceof OrderStockError) throw new ConnectorError('VALIDATION_ERROR', e.message);
  throw e;
}

/**
 * Order drafts are created by the AI agent only; members review them. Approve and reject are explicit human decisions
 * (any member: owner or manager). Approving needs complete checkout data, reduces stock atomically (fails whole if stock
 * no longer covers it) and, for cash on delivery, starts TTN creation. Later steps follow D25.
 */
export function registerOrderRoutes(app: FastifyInstance, deps: { shops: ShopRepository; auth: AuthRepository; orders: OrderRepository; delivery: DeliveryService }) {
  const { shops, auth, orders, delivery } = deps;
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
    summary: 'Approve a pending draft with complete checkout data: reduces stock for every line or fails without change; COD orders then get a TTN (any member)',
    tag: 'orders',
    auth: 'user',
    params: draftP,
    body: decisionBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'manager');
      try {
        const d = orders.approve(params.shopId, params.draftId, req.user!.user.id, body.note);
        delivery.afterApproval(params.shopId, d);
        return draftView(d);
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

  const draftAction = (url: string, summary: string, body: z.ZodType, fn: (shopId: string, draftId: string, userId: string, body: never) => OrderDraft | Promise<OrderDraft>) =>
    route(app, {
      method: 'POST',
      url: `/v1/shops/:shopId/order-drafts/:draftId/${url}`,
      summary,
      tag: 'orders',
      auth: 'user',
      params: draftP,
      body,
      handler: async ({ req, params, body: b }) => {
        requireRole(req, params.shopId, 'manager');
        try {
          return draftView(await fn(params.shopId, params.draftId, req.user!.user.id, b as never));
        } catch (e) {
          translate(e);
        }
      },
    });

  draftAction('cancel', 'Cancel an approved order before it ships; its stock comes back once (any member)', decisionBody, (shopId, draftId, userId, b: { note?: string }) =>
    orders.cancel(shopId, draftId, userId, b.note),
  );
  draftAction('ttn', 'Create the Nova Poshta TTN now, or retry after a refused attempt (any member). At most one TTN per order', z.strictObject({}), (shopId, draftId) =>
    delivery.createTtn(shopId, draftId),
  );
  draftAction('ttn/release', 'After checking the NP cabinet: no parcel exists for an uncertain TTN attempt, allow a retry (any member)', z.strictObject({}), (shopId, draftId) =>
    orders.releaseUncertainTtn(shopId, draftId),
  );
  draftAction('returned', 'The returning parcel is back at the shop: stock is restored once unless restock is false (any member)', returnedBody, (shopId, draftId, userId, b: { restock?: boolean; note?: string }) =>
    orders.markReturned(shopId, draftId, userId, b),
  );

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/order-drafts/:draftId/events',
    summary: 'Status history of an order: who or what moved it, from, to, when (any member)',
    tag: 'orders',
    auth: 'user',
    params: draftP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      if (!orders.getDraft(params.shopId, params.draftId)) throw new ConnectorError('NOT_FOUND', 'order draft not found');
      return { items: orders.listEvents(params.shopId, params.draftId).map(eventView) };
    },
  });
}
