import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors';
import { AuthValidationError, EmailTakenError, displayNameSchema, emailSchema, type AuthRepository, type UserRow } from '@hepson/database';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../auth/password';
import { RESET_TTL_MS, resetEmail, resetLink } from '../auth/reset';
import type { LoginThrottle } from '../auth/throttle';
import type { Mailer } from '../services/mailer';
import { RateLimiter } from '../services/rate-limit';
import { RateLimitedError } from '../services/web-chat';
import { route } from './define';

const password = z.string().min(10).max(128);
const registerBody = z.strictObject({ email: z.string(), displayName: z.string(), password });
const loginBody = z.strictObject({ email: z.string().max(254), password: z.string().max(128) });
const resetRequestBody = z.strictObject({ email: z.string().max(254) });
const resetConfirmBody = z.strictObject({ token: z.string().max(128), password });

export const publicUser = (u: Pick<UserRow, 'id' | 'email' | 'displayName'>) => ({ userId: u.id, email: u.email, displayName: u.displayName });

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthRepository,
  opts: { allowRegistration: boolean; sessionTtlMs: number; throttle: LoginThrottle; mailer: Mailer | null; dashboardUrl: string },
) {
  const { mailer } = opts;
  const resetsPerIp = new RateLimiter(10, 3_600_000);
  const resetsPerEmail = new RateLimiter(3, 3_600_000);
  const mail = (to: string, message: { subject: string; text: string }) =>
    void mailer!.send({ to, ...message }).catch((e: unknown) => app.log.warn({ code: (e as { code?: string }).code }, 'password reset email failed'));

  route(app, {
    method: 'POST',
    url: '/v1/auth/register',
    summary: 'Create a dashboard user (no shop access until a shop is created or the user is added)',
    tag: 'auth',
    auth: 'none',
    body: registerBody,
    status: 201,
    handler: async ({ body }) => {
      if (!opts.allowRegistration) throw new ApiError('FORBIDDEN', 'Registration is disabled');
      const email = emailSchema.safeParse(body.email);
      const name = displayNameSchema.safeParse(body.displayName);
      if (!email.success || !name.success) throw new ApiError('VALIDATION_ERROR', [!email.success && 'email invalid', !name.success && 'displayName invalid'].filter(Boolean).join('; '));
      const hash = await hashPassword(body.password);
      try {
        return publicUser(auth.createUser({ email: email.data, displayName: name.data }, hash));
      } catch (e) {
        if (e instanceof EmailTakenError) throw new ApiError('VALIDATION_ERROR', 'Email already registered');
        if (e instanceof AuthValidationError) throw new ApiError('VALIDATION_ERROR', e.message);
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
      if (opts.throttle.blocked(key)) throw new ApiError('RATE_LIMITED_OR_BLOCKED', 'Too many failed logins; try again later');
      const user = auth.getUserByEmail(key);
      const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !ok) {
        opts.throttle.fail(key);
        throw new ApiError('UNAUTHORIZED', 'Invalid email or password');
      }
      opts.throttle.reset(key);
      const s = auth.createSession(user.id, opts.sessionTtlMs);
      return { token: s.token, expiresAt: s.expiresAt, user: publicUser(user) };
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/auth/password-reset/request',
    summary: 'Email a one-time reset link. The answer is the same whether or not the email is registered (public, rate-limited).',
    tag: 'auth',
    auth: 'none',
    body: resetRequestBody,
    handler: ({ req, body }) => {
      if (!mailer) throw new ApiError('NOT_CONFIGURED', 'Password reset email is not configured on this server');
      const wait = resetsPerIp.hit(req.ip);
      if (wait) throw new RateLimitedError(wait);
      const key = body.email.trim().toLowerCase();
      // After the response, so its timing does not reveal whether the account exists; a capped address gets the same answer.
      setImmediate(() => {
        try {
          if (resetsPerEmail.hit(key)) return;
          const user = auth.getUserByEmail(key);
          if (user) mail(user.email, resetEmail.link(resetLink(opts.dashboardUrl, auth.createPasswordReset(user.id, RESET_TTL_MS))));
        } catch (e) {
          app.log.error({ err: (e as Error).message }, 'password reset request failed');
        }
      });
      return { ok: true };
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/auth/password-reset/confirm',
    summary: "Set a new password with a reset link token; ends all of the user's sessions",
    tag: 'auth',
    auth: 'none',
    body: resetConfirmBody,
    handler: async ({ body }) => {
      const invalid = () => new ApiError('VALIDATION_ERROR', 'This reset link is invalid or has expired');
      // Checked first so that a bad token never costs a password hash.
      if (!auth.isPasswordResetLive(body.token)) throw invalid();
      const user = auth.consumePasswordReset(body.token, await hashPassword(body.password));
      if (!user) throw invalid();
      opts.throttle.reset(user.email);
      if (mailer) mail(user.email, resetEmail.changed());
      return { ok: true };
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
