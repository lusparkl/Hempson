import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import { DeliveryValidationError, RefusalNotFoundError, type AuthRepository, type ConversationRepository, type DeliveryRepository, type OrderRepository, type RefusalRow, type ShopRepository } from '@hepson/database';
import type { DeliveryService } from '../services/delivery';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const customerP = z.object({ shopId: z.uuid(), customerId: z.uuid() });
const refusalP = z.object({ shopId: z.uuid(), customerId: z.uuid(), refusalId: z.uuid() });
const keyBody = z.strictObject({ apiKey: z.string().trim().min(1).max(100) });
const cityQ = z.object({ q: z.string().trim().min(2).max(100) });
const branchQ = z.object({ cityRef: z.string().trim().min(1).max(64), q: z.string().trim().max(100).default('') });
const settingsBody = z.strictObject({
  senderCityRef: z.string().nullable().optional(),
  senderCityName: z.string().nullable().optional(),
  senderWarehouseRef: z.string().nullable().optional(),
  senderWarehouseName: z.string().nullable().optional(),
  codEnabled: z.boolean().optional(),
  prepaidEnabled: z.boolean().optional(),
  refusalLimit: z.number().int().optional(),
  parcelWeightKg: z.string().optional(),
  parcelDescription: z.string().optional(),
});
const refusalBody = z.strictObject({ note: z.string().max(500).optional() });

const refusalView = (r: RefusalRow) => ({ refusalId: r.id, source: r.source, draftId: r.draftId, note: r.note, createdByUserId: r.createdByUserId, createdAt: r.createdAt });

/**
 * Nova Poshta (P4): the shop's own API key (owner, stored encrypted, never returned), sender and checkout settings
 * (owner), city/branch lookups (any member, for the sender settings), and the per-customer refusal count (D25).
 */
export function registerDeliveryRoutes(
  app: FastifyInstance,
  deps: { shops: ShopRepository; auth: AuthRepository; delivery: DeliveryService; deliveryRepo: DeliveryRepository; orders: OrderRepository; conversations: ConversationRepository },
) {
  const { shops, auth, delivery, deliveryRepo, orders, conversations } = deps;
  const requireRole = makeRequireRole(shops, auth);
  const translate = (e: unknown): never => {
    if (e instanceof DeliveryValidationError) throw new ConnectorError('VALIDATION_ERROR', e.message);
    if (e instanceof RefusalNotFoundError) throw new ConnectorError('NOT_FOUND', e.message);
    throw e;
  };

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/nova-poshta',
    summary: 'Nova Poshta connection, sender and checkout settings (any member). Never returns the API key',
    tag: 'delivery',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      return delivery.status(params.shopId);
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/nova-poshta/key',
    summary: "Connect the shop's Nova Poshta API key (owner): reads the sender from NP, then stores the key encrypted",
    tag: 'delivery',
    auth: 'user',
    params: shopP,
    body: keyBody,
    handler: async ({ req, params, body }) => {
      requireRole(req, params.shopId, 'owner');
      return delivery.connect(params.shopId, body.apiKey);
    },
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/shops/:shopId/nova-poshta/key',
    summary: 'Delete the stored Nova Poshta API key (owner). Settings are kept',
    tag: 'delivery',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'owner');
      delivery.disconnect(params.shopId);
      return delivery.status(params.shopId);
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/nova-poshta/settings',
    summary: 'Sender city/branch, COD and prepaid switches, refusal limit (0-3), parcel weight and description (owner)',
    tag: 'delivery',
    auth: 'user',
    params: shopP,
    body: settingsBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'owner');
      try {
        deliveryRepo.updateSettings(params.shopId, body);
      } catch (e) {
        translate(e);
      }
      return delivery.status(params.shopId);
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/nova-poshta/cities',
    summary: 'Find Nova Poshta cities with the shop key (any member)',
    tag: 'delivery',
    auth: 'user',
    params: shopP,
    query: cityQ,
    handler: async ({ req, params, query }) => {
      requireRole(req, params.shopId, 'manager');
      return { items: await delivery.cities(params.shopId, query.q) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/nova-poshta/branches',
    summary: 'Find working Nova Poshta branches of a city with the shop key (any member)',
    tag: 'delivery',
    auth: 'user',
    params: shopP,
    query: branchQ,
    handler: async ({ req, params, query }) => {
      requireRole(req, params.shopId, 'manager');
      return { items: await delivery.warehouses(params.shopId, query.cityRef, query.q) };
    },
  });

  // Refusals are counted by the phone of the customer's latest order, else by customer id (D25).
  const latestPhone = (shopId: string, customerId: string) =>
    orders
      .listDrafts(shopId, { limit: 200 })
      .items.find((d) => d.draft.customerId === customerId && d.draft.recipientPhone)?.draft.recipientPhone ?? null;
  const refusalState = (shopId: string, customerId: string) => {
    const phone = latestPhone(shopId, customerId);
    const pm = deliveryRepo.paymentMethods(shopId, { phone, customerId });
    return { customerId, phone, refusals: pm.refusals, codBlocked: pm.codBlocked, limit: deliveryRepo.getSettings(shopId).refusalLimit, items: deliveryRepo.listRefusals(shopId, { phone, customerId }).map(refusalView) };
  };
  const requireCustomer = (shopId: string, customerId: string) => {
    if (!conversations.getCustomer(shopId, customerId)) throw new ConnectorError('NOT_FOUND', 'customer not found');
  };

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/customers/:customerId/refusals',
    summary: 'Refused parcels counted for a customer and whether COD is still offered (any member)',
    tag: 'delivery',
    auth: 'user',
    params: customerP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      requireCustomer(params.shopId, params.customerId);
      return refusalState(params.shopId, params.customerId);
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/shops/:shopId/customers/:customerId/refusals',
    summary: 'Record a refused parcel by hand (any member)',
    tag: 'delivery',
    auth: 'user',
    params: customerP,
    body: refusalBody,
    status: 201,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'manager');
      requireCustomer(params.shopId, params.customerId);
      try {
        deliveryRepo.addMemberRefusal(params.shopId, { customerId: params.customerId, note: body.note }, req.user!.user.id, latestPhone(params.shopId, params.customerId));
      } catch (e) {
        translate(e);
      }
      return refusalState(params.shopId, params.customerId);
    },
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/shops/:shopId/customers/:customerId/refusals/:refusalId',
    summary: 'Remove a recorded refusal (any member)',
    tag: 'delivery',
    auth: 'user',
    params: refusalP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      requireCustomer(params.shopId, params.customerId);
      try {
        deliveryRepo.removeRefusal(params.shopId, params.refusalId);
      } catch (e) {
        translate(e);
      }
      return refusalState(params.shopId, params.customerId);
    },
  });
}
