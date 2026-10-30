import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import type { AuthRepository, ShopRepository } from '@hepson/database';
import { InstagramAccountSelectionError, verifySignature, type InstagramService } from '../services/instagram';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const callbackQ = z.object({ code: z.string().min(1).max(2048).optional(), state: z.string().min(1).max(256).optional(), error: z.string().max(100).optional() });
const handshakeQ = z.object({ 'hub.mode': z.string().max(50).optional(), 'hub.verify_token': z.string().max(256).optional(), 'hub.challenge': z.string().max(256).optional() });

const sameSecret = (a: string, b: string) => {
  const given = Buffer.from(a);
  const expected = Buffer.from(b);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/**
 * Instagram (D23): owner connect flow and Meta's webhook. The webhook is authenticated only by the HMAC of the raw body
 * (checked before any parsing); the callback only by the single-use `state` created for a logged-in owner.
 */
export async function registerInstagramRoutes(
  app: FastifyInstance,
  deps: { shops: ShopRepository; auth: AuthRepository; ig: InstagramService; appSecret?: string; verifyToken?: string; dashboardUrl: string },
): Promise<void> {
  const { shops, auth, ig, appSecret, verifyToken, dashboardUrl } = deps;
  const requireRole = makeRequireRole(shops, auth);

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/instagram',
    summary: 'Instagram connection state (any member). Never returns tokens',
    tag: 'instagram',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      return ig.status(params.shopId);
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/shops/:shopId/instagram/connect',
    summary: 'Start the Instagram business login (owner): returns the URL to open',
    tag: 'instagram',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'owner');
      return ig.startConnect(params.shopId, req.user!.user.id);
    },
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/shops/:shopId/instagram',
    summary: 'Disconnect Instagram and delete the stored token (owner)',
    tag: 'instagram',
    auth: 'user',
    params: shopP,
    handler: async ({ req, params }) => {
      requireRole(req, params.shopId, 'owner');
      await ig.disconnect(params.shopId);
      return { ok: true };
    },
  });

  route(app, {
    method: 'GET',
    url: '/public/instagram/callback',
    summary: 'OAuth redirect target registered in the Meta app; redirects the browser to the dashboard',
    tag: 'instagram',
    auth: 'none',
    query: callbackQ,
    handler: async ({ req, query, reply }) => {
      const back = (result: string) => reply.redirect(`${dashboardUrl}/?instagram=${result}`, 302);
      if (query.error) return back('denied');
      if (!query.code || !query.state) return back('error');
      try {
        await ig.completeConnect(query.code, query.state);
        return back('connected');
      } catch (e) {
        // Codes only: never the URL, token or Meta's message text.
        req.log.warn({ err: e instanceof Error ? e.name : 'ERROR', code: e instanceof ConnectorError ? e.code : undefined }, 'instagram connect failed');
        if (e instanceof InstagramAccountSelectionError) return back('select_one');
        return back(e instanceof ConnectorError && e.code === 'VALIDATION_ERROR' ? 'taken' : 'error');
      }
    },
  });

  if (!appSecret || !verifyToken) return;

  route(app, {
    method: 'GET',
    url: '/webhooks/instagram',
    summary: "Meta webhook handshake (hub.challenge); checks the operator's verify token",
    tag: 'instagram',
    auth: 'none',
    query: handshakeQ,
    handler: ({ query, reply }) => {
      const given = query['hub.verify_token'];
      if (query['hub.mode'] !== 'subscribe' || !given || !sameSecret(given, verifyToken)) throw new ConnectorError('FORBIDDEN', 'Verification failed');
      reply.type('text/plain');
      return query['hub.challenge'] ?? '';
    },
  });

  // Own scope: the JSON parser here keeps the raw bytes, because the signature covers them exactly.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    route(scope, {
      method: 'POST',
      url: '/webhooks/instagram',
      summary: 'Meta webhook: messages and echoes. Requires a valid X-Hub-Signature-256; stores nothing otherwise',
      tag: 'instagram',
      auth: 'none',
      bodyLimit: 512 * 1024,
      handler: ({ req }) => {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const sig = req.headers['x-hub-signature-256'];
        if (!verifySignature(raw, typeof sig === 'string' ? sig : undefined, appSecret)) throw new ConnectorError('UNAUTHORIZED', 'Invalid signature');
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new ConnectorError('VALIDATION_ERROR', 'Body is not JSON');
        }
        ig.handleWebhook(payload);
        return { ok: true };
      },
    });
  });
}
