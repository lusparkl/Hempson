import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import { PaymentValidationError, type AuthRepository, type PaymentRepository, type ShopRepository } from '@hepson/database';
import type { PaymentService } from '../services/payments';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const webhookP = z.object({ webhookId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });
const tokenBody = z.strictObject({ token: z.string().trim().min(1).max(300) });
const settingsBody = z.strictObject({ paymentTimeoutHours: z.number().int().optional(), reminderHoursBefore: z.number().int().optional() });

/**
 * Monobank payment links (P5, D24): the shop's own acquiring token (owner, stored encrypted, never returned), the payment
 * deadline and reminder settings (owner), and the public webhook. The webhook is authenticated only by Monobank's
 * `x-sign` ECDSA signature over the raw body; an unknown path and a bad signature get the same 401 and store nothing.
 */
export async function registerPaymentRoutes(app: FastifyInstance, deps: { shops: ShopRepository; auth: AuthRepository; payments: PaymentService; paymentRepo: PaymentRepository }) {
  const { shops, auth, payments, paymentRepo } = deps;
  const requireRole = makeRequireRole(shops, auth);

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/monobank',
    summary: 'Monobank connection and payment settings (any member). Never returns the token',
    tag: 'payments',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      return payments.status(params.shopId);
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/monobank/token',
    summary: "Connect the shop's Monobank acquiring token (owner): checks it with Monobank, then stores it encrypted",
    tag: 'payments',
    auth: 'user',
    params: shopP,
    body: tokenBody,
    handler: async ({ req, params, body }) => {
      requireRole(req, params.shopId, 'owner');
      return payments.connect(params.shopId, body.token);
    },
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/shops/:shopId/monobank/token',
    summary: 'Delete the stored Monobank token (owner). Prepaid is no longer offered; payments already made are still recognised',
    tag: 'payments',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'owner');
      payments.disconnect(params.shopId);
      return payments.status(params.shopId);
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/monobank/settings',
    summary: 'Payment deadline in hours (1-720) and reminder hours before it (0 = none) for unpaid orders (owner)',
    tag: 'payments',
    auth: 'user',
    params: shopP,
    body: settingsBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'owner');
      try {
        paymentRepo.updateSettings(params.shopId, body);
      } catch (e) {
        if (e instanceof PaymentValidationError) throw new ConnectorError('VALIDATION_ERROR', e.message);
        throw e;
      }
      return payments.status(params.shopId);
    },
  });

  // Own scope: the JSON parser here keeps the raw bytes, because the signature covers them exactly.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    route(scope, {
      method: 'POST',
      url: '/webhooks/monobank/:webhookId',
      summary: "Monobank invoice status webhook for one shop. Requires a valid x-sign signature (Monobank's ECDSA key); stores nothing otherwise",
      tag: 'payments',
      auth: 'none',
      params: webhookP,
      handler: async ({ req, params }) => {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const sig = req.headers['x-sign'];
        if (!(await payments.handleWebhook(params.webhookId, raw, typeof sig === 'string' ? sig : undefined))) throw new ConnectorError('UNAUTHORIZED', 'Invalid signature');
        return { ok: true };
      },
    });
  });
}
