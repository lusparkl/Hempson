import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import type { AccountRow, AuthRepository, ShopRepository, Store } from '@hepson/database';
import type { ChannelBridge } from '../services/channel-bridge';
import { channelOf } from '../services/channel-bridge';
import { route } from './define';
import { makeRequireRole } from './shops';

const accountP = z.object({ accountId: z.uuid() });
const shopP = z.object({ shopId: z.uuid() });

const channelView = (a: AccountRow) => ({ accountId: a.id, label: a.label, connectorType: a.connectorType, channel: channelOf(a.connectorType), status: a.status });

/**
 * Linking a connector account to a shop is an operator action (admin API key): a shop owner must not be able to claim
 * someone else's Instagram account by id. Members can only list what is linked to their shop.
 */
export function registerChannelRoutes(app: FastifyInstance, deps: { store: Store; shops: ShopRepository; auth: AuthRepository; bridge: ChannelBridge }) {
  const { store, shops, auth, bridge } = deps;
  const requireRole = makeRequireRole(shops, auth);

  route(app, {
    method: 'PUT',
    url: '/v1/accounts/:accountId/shop',
    summary: 'Link a connector account to a shop and mirror its cached history into the shop (admin key)',
    tag: 'channels',
    auth: 'admin',
    params: accountP,
    body: z.strictObject({ shopId: z.uuid() }),
    handler: ({ params, body }) => {
      const acc = store.getAccount(params.accountId);
      if (!acc) throw new ConnectorError('NOT_FOUND', 'Account not found');
      if (!shops.get(body.shopId)) throw new ConnectorError('NOT_FOUND', 'Shop not found');
      if (acc.shopId && acc.shopId !== body.shopId) throw new ConnectorError('VALIDATION_ERROR', 'Account is already linked to another shop; unlink it first');
      store.updateAccount(acc.id, { shopId: body.shopId });
      const mirrored = bridge.backfill(acc.id);
      return { accountId: acc.id, shopId: body.shopId, mirroredMessages: mirrored };
    },
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/accounts/:accountId/shop',
    summary: 'Unlink a connector account from its shop; stops mirroring, mirrored shop data is kept (admin key)',
    tag: 'channels',
    auth: 'admin',
    params: accountP,
    handler: ({ params }) => {
      const acc = store.getAccount(params.accountId);
      if (!acc) throw new ConnectorError('NOT_FOUND', 'Account not found');
      store.updateAccount(acc.id, { shopId: null });
      return { accountId: acc.id, shopId: null };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/channels',
    summary: 'List connector accounts linked to the shop (any member)',
    tag: 'channels',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      return { items: store.listAccountsForShop(params.shopId).map(channelView) };
    },
  });
}
