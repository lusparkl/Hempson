import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import {
  AuthValidationError,
  LastOwnerError,
  MembershipExistsError,
  MembershipNotFoundError,
  ShopNotFoundError,
  ShopSlugTakenError,
  ShopValidationError,
  emailSchema,
  roleSchema,
  type AuthRepository,
  type DbHandle,
  type Role,
  type ShopRepository,
  type ShopRow,
} from '@hepson/database';
import { route } from './define';

const shopId = z.object({ shopId: z.uuid() });
const memberParams = z.object({ shopId: z.uuid(), userId: z.uuid() });
const createBody = z.strictObject({ name: z.string(), slug: z.string(), defaultCurrency: z.string().optional(), defaultLanguage: z.string().optional() });
const updateBody = z.strictObject({ name: z.string().optional(), slug: z.string().optional(), defaultCurrency: z.string().optional(), defaultLanguage: z.string().optional() });
const addMemberBody = z.strictObject({ email: z.string().max(254), role: roleSchema });
const roleBody = z.strictObject({ role: roleSchema });

const shopView = (s: ShopRow, role: Role) => ({ shopId: s.id, name: s.name, slug: s.slug, defaultCurrency: s.defaultCurrency, defaultLanguage: s.defaultLanguage, createdAt: s.createdAt, updatedAt: s.updatedAt, role });

/** Maps domain errors to API errors. */
function translate(e: unknown): never {
  if (e instanceof ShopValidationError || e instanceof AuthValidationError) throw new ConnectorError('VALIDATION_ERROR', e.message);
  if (e instanceof ShopSlugTakenError) throw new ConnectorError('VALIDATION_ERROR', 'Slug already in use');
  if (e instanceof MembershipExistsError) throw new ConnectorError('VALIDATION_ERROR', e.message);
  if (e instanceof LastOwnerError) throw new ConnectorError('VALIDATION_ERROR', e.message);
  if (e instanceof MembershipNotFoundError || e instanceof ShopNotFoundError) throw new ConnectorError('NOT_FOUND', 'Not found');
  throw e;
}

/**
 * Single authorization choke point for shop-scoped routes. Non-members get 404 (shop existence is not
 * revealed); members below `min` get 403. The shopId always comes from the URL and is checked against
 * the authenticated user's membership.
 */
export function makeRequireRole(shops: ShopRepository, auth: AuthRepository) {
  return function requireRole(req: FastifyRequest, id: string, min: Role): { shop: ShopRow; role: Role } {
    const m = auth.getMembership(id, req.user!.user.id);
    const shop = m && shops.get(id);
    if (!m || !shop) throw new ConnectorError('NOT_FOUND', 'Shop not found');
    if (min === 'owner' && m.role !== 'owner') throw new ConnectorError('FORBIDDEN', 'Owner role required');
    return { shop, role: m.role };
  };
}

export function registerShopRoutes(app: FastifyInstance, deps: { shops: ShopRepository; auth: AuthRepository; handle: DbHandle }) {
  const { shops, auth, handle } = deps;
  const requireRole = makeRequireRole(shops, auth);

  route(app, {
    method: 'POST',
    url: '/v1/shops',
    summary: 'Create a shop; the caller becomes its owner',
    tag: 'shops',
    auth: 'user',
    body: createBody,
    status: 201,
    handler: ({ req, body }) => {
      try {
        const shop = handle.raw.transaction(() => {
          const s = shops.create(body);
          auth.addMember(s.id, req.user!.user.id, 'owner');
          return s;
        })();
        return shopView(shop, 'owner');
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops',
    summary: "Shops the caller belongs to",
    tag: 'shops',
    auth: 'user',
    handler: ({ req }) => auth.listShopsForUser(req.user!.user.id).map(({ shop, role }) => shopView(shop, role)),
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId',
    summary: 'Get a shop (any member)',
    tag: 'shops',
    auth: 'user',
    params: shopId,
    handler: ({ req, params }) => {
      const { shop, role } = requireRole(req, params.shopId, 'manager');
      return shopView(shop, role);
    },
  });

  route(app, {
    method: 'PATCH',
    url: '/v1/shops/:shopId',
    summary: 'Update shop settings (owner)',
    tag: 'shops',
    auth: 'user',
    params: shopId,
    body: updateBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'owner');
      try {
        return shopView(shops.update(params.shopId, body), 'owner');
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/members',
    summary: 'List members (any member)',
    tag: 'shops',
    auth: 'user',
    params: shopId,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      return auth.listMembers(params.shopId).map(({ membership, user }) => ({ userId: user.id, email: user.email, displayName: user.displayName, role: membership.role, since: membership.createdAt }));
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/shops/:shopId/members',
    summary: 'Add an existing user by email (owner)',
    tag: 'shops',
    auth: 'user',
    params: shopId,
    body: addMemberBody,
    status: 201,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'owner');
      const email = emailSchema.safeParse(body.email);
      const user = email.success ? auth.getUserByEmail(email.data) : undefined;
      if (!user) throw new ConnectorError('NOT_FOUND', 'No registered user with that email');
      try {
        const m = auth.addMember(params.shopId, user.id, body.role);
        return { userId: user.id, email: user.email, displayName: user.displayName, role: m.role, since: m.createdAt };
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'PATCH',
    url: '/v1/shops/:shopId/members/:userId',
    summary: 'Change a member role (owner); the last owner cannot be demoted',
    tag: 'shops',
    auth: 'user',
    params: memberParams,
    body: roleBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'owner');
      try {
        const m = auth.changeRole(params.shopId, params.userId, body.role);
        return { userId: m.userId, role: m.role };
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/shops/:shopId/members/:userId',
    summary: 'Remove a member (owner), or leave the shop yourself (any member); the last owner cannot be removed',
    tag: 'shops',
    auth: 'user',
    params: memberParams,
    handler: ({ req, params }) => {
      const self = params.userId === req.user!.user.id;
      requireRole(req, params.shopId, self ? 'manager' : 'owner');
      try {
        auth.removeMember(params.shopId, params.userId);
        return { ok: true };
      } catch (e) {
        translate(e);
      }
    },
  });
}
