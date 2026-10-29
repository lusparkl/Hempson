import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import { AuthValidationError, EmailTakenError, displayNameSchema, emailSchema, type AuthRepository, type UserRow } from '@hepson/database';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../auth/password';
import type { LoginThrottle } from '../auth/throttle';
import { route } from './define';

const password = z.string().min(10).max(128);
const registerBody = z.strictObject({ email: z.string(), displayName: z.string(), password });
const loginBody = z.strictObject({ email: z.string().max(254), password: z.string().max(128) });

export const publicUser = (u: Pick<UserRow, 'id' | 'email' | 'displayName'>) => ({ userId: u.id, email: u.email, displayName: u.displayName });

export function registerAuthRoutes(app: FastifyInstance, auth: AuthRepository, opts: { allowRegistration: boolean; sessionTtlMs: number; throttle: LoginThrottle }) {
  route(app, {
    method: 'POST',
    url: '/v1/auth/register',
    summary: 'Create a dashboard user (no shop access until a shop is created or the user is added)',
    tag: 'auth',
    auth: 'none',
    body: registerBody,
    status: 201,
    handler: async ({ body }) => {
      if (!opts.allowRegistration) throw new ConnectorError('FORBIDDEN', 'Registration is disabled');
      const email = emailSchema.safeParse(body.email);
      const name = displayNameSchema.safeParse(body.displayName);
      if (!email.success || !name.success) throw new ConnectorError('VALIDATION_ERROR', [!email.success && 'email invalid', !name.success && 'displayName invalid'].filter(Boolean).join('; '));
      const hash = await hashPassword(body.password);
      try {
        return publicUser(auth.createUser({ email: email.data, displayName: name.data }, hash));
      } catch (e) {
        if (e instanceof EmailTakenError) throw new ConnectorError('VALIDATION_ERROR', 'Email already registered');
        if (e instanceof AuthValidationError) throw new ConnectorError('VALIDATION_ERROR', e.message);
        throw e;
      }
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/auth/login',
    summary: 'Exchange email + password for a session bearer token (hsu_…)',
    tag: 'auth',
    auth: 'none',
    body: loginBody,
    handler: async ({ body }) => {
      const key = body.email.trim().toLowerCase();
      if (opts.throttle.blocked(key)) throw new ConnectorError('RATE_LIMITED_OR_BLOCKED', 'Too many failed logins; try again later');
      const user = auth.getUserByEmail(key);
      const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !ok) {
        opts.throttle.fail(key);
        throw new ConnectorError('UNAUTHORIZED', 'Invalid email or password');
      }
      opts.throttle.reset(key);
      const s = auth.createSession(user.id, opts.sessionTtlMs);
      return { token: s.token, expiresAt: s.expiresAt, user: publicUser(user) };
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/auth/logout',
    summary: 'Revoke the current session',
    tag: 'auth',
    auth: 'user',
    handler: ({ req }) => {
      auth.revokeSession(req.user!.sessionId);
      return { ok: true };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/auth/me',
    summary: 'Current user and their shops',
    tag: 'auth',
    auth: 'user',
    handler: ({ req }) => ({
      user: publicUser(req.user!.user),
      shops: auth.listShopsForUser(req.user!.user.id).map(({ shop, role }) => ({ shopId: shop.id, name: shop.name, slug: shop.slug, role })),
    }),
  });
}
