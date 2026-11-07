import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthRepository, ShopRepository } from '@hepson/database';
import type { PhotoSearchService } from '../services/photo-search';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });

/** P9 photo search index state (D42). Indexing itself runs in the background after catalog changes. */
export function registerPhotoSearchRoutes(app: FastifyInstance, deps: { shops: ShopRepository; auth: AuthRepository; photos: PhotoSearchService | null }) {
  const { shops, auth, photos } = deps;
  const requireRole = makeRequireRole(shops, auth);
  const view = (shopId: string) => (photos ? { available: true, ...photos.status(shopId) } : { available: false, withPhoto: 0, indexed: 0, failed: 0, pending: 0 });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/photo-index',
    summary: 'Photo search index: products with a main image, indexed, failed (image unreadable or not a product) and pending (any member)',
    tag: 'catalog',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      return view(params.shopId);
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/shops/:shopId/photo-index/retry',
    summary: 'Try failed product images again, e.g. after fixing a link (owner)',
    tag: 'catalog',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'owner');
      if (photos) {
        photos.clearFailed(params.shopId);
        photos.schedule();
      }
      return view(params.shopId);
    },
  });
}
