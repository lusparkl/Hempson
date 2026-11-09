import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors';
import {
  AuthValidationError,
  LastOwnerError,
  MembershipExistsError,
  MembershipNotFoundError,
  ShopNotFoundError,
  ShopSlugTakenError,
  ShopValidationError,
  createShopWithOwner,
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
const updateBody = z.strictObject({
  name: z.string().optional(),
  slug: z.string().optional(),
  defaultCurrency: z.string().optional(),
  defaultLanguage: z.string().optional(),
  storefrontEnabled: z.boolean().optional(),
});
const addMemberBody = z.strictObject({ email: z.string().max(254), role: roleSchema });
const roleBody = z.strictObject({ role: roleSchema });

const shopView = (s: ShopRow, role: Role) => ({
  shopId: s.id,
  name: s.name,
  slug: s.slug,
  defaultCurrency: s.defaultCurrency,
  defaultLanguage: s.defaultLanguage,
  storefrontEnabled: s.storefrontEnabled,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  role,
});

/** Maps domain errors to API errors. */
function translate(e: unknown): never {
  if (e instanceof ShopValidationError || e instanceof AuthValidationError) throw new ApiError('VALIDATION_ERROR', e.message);
  if (e instanceof ShopSlugTakenError) throw new ApiError('VALIDATION_ERROR', 'Slug already in use');
  if (e instanceof MembershipExistsError) throw new ApiError('VALIDATION_ERROR', e.message);
  if (e instanceof LastOwnerError) throw new ApiError('VALIDATION_ERROR', e.message);
  if (e instanceof MembershipNotFoundError || e instanceof ShopNotFoundError) throw new ApiError('NOT_FOUND', 'Not found');
  throw e;
}

/**
 * Single authorization choke point for shop-scoped routes. Non-members get 404 (shop existence is not
 * revealed); members below `min` get 403. The shopId always comes from the URL and is checked against
 * the authenticated user's membership.
 */
export function makeRequireRole(shops: ShopRepository, auth: AuthRepository) {
  return async function requireRole(req: FastifyRequest, id: string, min: Role): Promise<{ shop: ShopRow; role: Role }> {
    const m = await auth.getMembership(id, req.user!.user.id);
    const shop = m && (await shops.get(id));
    if (!m || !shop) throw new ApiError('NOT_FOUND', 'Shop not found');
    if (min === 'owner' && m.role !== 'owner') throw new ApiError('FORBIDDEN', 'Owner role required');
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
    handler: async ({ req, body }) => {
      try {
        const shop = await createShopWithOwner({ handle, shops, auth }, body, req.user!.user.id);
        return shopView(shop, 'owner');
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops',
    summary: 'Shops the caller belongs to',
    tag: 'shops',
    auth: 'user',
    handler: async ({ req }) => (await auth.listShopsForUser(req.user!.user.id)).map(({ shop, role }) => shopView(shop, role)),
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId',
    summary: 'Get a shop (any member)',
    tag: 'shops',
    auth: 'user',
    params: shopId,
    handler: async ({ req, params }) => {
      const { shop, role } = await requireRole(req, params.shopId, 'manager');
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
    handler: async ({ req, params, body }) => {
      await requireRole(req, params.shopId, 'owner');
      try {
        return shopView(await shops.update(params.shopId, body), 'owner');
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
    handler: async ({ req, params }) => {
      await requireRole(req, params.shopId, 'manager');
      return (await auth.listMembers(params.shopId)).map(({ membership, user }) => ({
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: membership.role,
        since: membership.createdAt,
      }));
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
    handler: async ({ req, params, body }) => {
      await requireRole(req, params.shopId, 'owner');
      const email = emailSchema.safeParse(body.email);
      const user = email.success ? await auth.getUserByEmail(email.data) : undefined;
      if (!user) throw new ApiError('NOT_FOUND', 'No registered user with that email');
      try {
        const m = await auth.addMember(params.shopId, user.id, body.role);
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
    handler: async ({ req, params, body }) => {
      await requireRole(req, params.shopId, 'owner');
      try {
        const m = await auth.changeRole(params.shopId, params.userId, body.role);
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
    handler: async ({ req, params }) => {
      const self = params.userId === req.user!.user.id;
      await requireRole(req, params.shopId, self ? 'manager' : 'owner');
      try {
        await auth.removeMember(params.shopId, params.userId);
        return { ok: true };
      } catch (e) {
        translate(e);
      }
    },
  });
}
