import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthRepository, ShopRepository } from '@hepson/database';
import type { TelegramService } from '../services/telegram';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const webhookP = z.object({ webhookId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });
const connectBody = z.strictObject({ token: z.string().trim().min(1).max(200) });

/**
 * Telegram customer channel (D27): the owner connects the shop's own bot by pasting its BotFather token; Telegram's
 * webhook is authenticated only by the per-shop `X-Telegram-Bot-Api-Secret-Token` header.
 */
export function registerTelegramRoutes(app: FastifyInstance, deps: { shops: ShopRepository; auth: AuthRepository; tg: TelegramService }): void {
  const { shops, auth, tg } = deps;
  const requireRole = makeRequireRole(shops, auth);

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/telegram',
    summary: 'Telegram bot connection state (any member). Never returns the token',
    tag: 'telegram',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      return tg.status(params.shopId);
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/telegram',
    summary: "Connect the shop's Telegram bot (owner): checks the token, registers the webhook, stores the token encrypted",
    tag: 'telegram',
    auth: 'user',
    params: shopP,
    body: connectBody,
    handler: async ({ req, params, body }) => {
      requireRole(req, params.shopId, 'owner');
      return tg.connect(params.shopId, body.token);
    },
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/shops/:shopId/telegram',
    summary: 'Disconnect the Telegram bot: removes the webhook and deletes the stored token (owner)',
    tag: 'telegram',
    auth: 'user',
    params: shopP,
    handler: async ({ req, params }) => {
      requireRole(req, params.shopId, 'owner');
      await tg.disconnect(params.shopId);
      return { ok: true };
    },
  });

  route(app, {
    method: 'POST',
    url: '/webhooks/telegram/:webhookId',
    summary: 'Telegram webhook for one shop bot. Requires the matching X-Telegram-Bot-Api-Secret-Token; stores nothing otherwise',
    tag: 'telegram',
    auth: 'none',
    params: webhookP,
    handler: ({ req, params }) => {
      const secret = req.headers['x-telegram-bot-api-secret-token'];
      tg.handleUpdate(params.webhookId, typeof secret === 'string' ? secret : undefined, req.body);
      return { ok: true };
    },
  });
}
