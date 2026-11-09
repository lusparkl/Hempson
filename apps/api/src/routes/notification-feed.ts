import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthRepository, NotificationRepository, ShopRepository } from '@hepson/database';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const feedQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

/**
 * P10 notification centre of the dashboard (any member): hand-offs, new orders, payment and TTN problems of the last
 * 30 days with the calling member's read state. Separate from `/notifications`, which configures the Telegram chat.
 */
export function registerNotificationFeedRoutes(app: FastifyInstance, deps: { shops: ShopRepository; auth: AuthRepository; feed: NotificationRepository }) {
  const { shops, auth, feed } = deps;
  const requireRole = makeRequireRole(shops, auth);

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/notification-feed',
    summary: "Notification feed, newest first: hand-offs, new orders, payment and TTN problems of the last 30 days; `unread` counts items after the member's `seenAt` (any member)",
    tag: 'notifications',
    auth: 'user',
    params: shopP,
    query: feedQuery,
    handler: async ({ req, params, query }) => {
      await requireRole(req, params.shopId, 'manager');
      return await feed.feed(params.shopId, req.user!.user.id, query);
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/shops/:shopId/notification-feed/seen',
    summary: 'Mark every notification up to now as seen by the calling member (any member)',
    tag: 'notifications',
    auth: 'user',
    params: shopP,
    handler: async ({ req, params }) => {
      await requireRole(req, params.shopId, 'manager');
      return { seenAt: await feed.markSeen(params.shopId, req.user!.user.id) };
    },
  });
}
