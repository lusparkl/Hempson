import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors';
import { WebChatValidationError, type AuthRepository, type ShopRepository, type WebChatConfigRow, type WebChatRepository } from '@hepson/database';
import type { WebChatService } from '../services/web-chat';
import { visitorView } from '../services/web-chat';
import { route } from './define';
import { makeRequireRole } from './shops';

const widgetSource = readFileSync(new URL('../widget/web-chat.js', import.meta.url), 'utf8');

const shopP = z.object({ shopId: z.uuid() });
const keyP = z.object({ widgetKey: z.string().min(8).max(64) });
const sessionBody = z.strictObject({ name: z.string().trim().min(1).max(60).optional() });
const afterQ = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });
const configBody = z.strictObject({ enabled: z.boolean().optional(), allowedOrigins: z.array(z.string()).max(20).optional() });

const CORS_PREFIX = /^\/public\/web-chat\/([^/?#]+)/;

/**
 * Public website chat (Feature 10). These are the only unauthenticated shop-facing routes; see D19 for the layers:
 * widget key -> enabled config -> exact Origin allow-list -> visitor token -> rate limits.
 * `Origin` stops other websites from embedding a shop's chat in a browser; it is not authentication (any non-browser client can set it).
 */
export function registerWebChatRoutes(
  app: FastifyInstance,
  deps: { shops: ShopRepository; auth: AuthRepository; webChat: WebChatRepository; svc: WebChatService; publicUrl: string },
) {
  const { shops, auth, webChat, svc, publicUrl } = deps;
  const requireRole = makeRequireRole(shops, auth);
  const ownOrigin = new URL(publicUrl).origin.toLowerCase();
  /** The page's origin. Browsers omit `Origin` on same-origin GETs, so the storefront page (P9) is recognised by `Sec-Fetch-Site`. */
  const originOf = (req: FastifyRequest) => req.headers.origin ?? (req.headers['sec-fetch-site'] === 'same-origin' ? ownOrigin : undefined);
  /** A shop's allowed origins, plus this server's own origin while the shop's storefront page is on (the widget runs there). */
  const allowed = async (cfg: WebChatConfigRow, origin: string | undefined) =>
    svc.originAllowed(cfg, origin) || (!!origin && origin.toLowerCase() === ownOrigin && (await shops.get(cfg.shopId))?.storefrontEnabled === true);

  // CORS: only an allowed origin of an enabled widget gets Access-Control-Allow-Origin; everyone else is blocked by the browser and refused by the handlers.
  app.addHook('onRequest', async (req, reply) => {
    const m = CORS_PREFIX.exec(req.url);
    if (!m) return;
    const cfg = await svc.config(safeDecode(m[1]!));
    const origin = req.headers.origin;
    const ok = !!cfg && (await allowed(cfg, origin));
    if (ok) {
      reply
        .header('access-control-allow-origin', origin!)
        .header('vary', 'Origin')
        .header('access-control-allow-headers', 'content-type, x-hepson-visitor')
        .header('access-control-allow-methods', 'GET, POST, OPTIONS')
        .header('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') return reply.code(ok ? 204 : 403).send();
  });

  /** Unknown/disabled key = 404 (no existence leak); wrong or missing Origin = 403. */
  const gate = async (req: FastifyRequest, widgetKey: string): Promise<WebChatConfigRow> => {
    const cfg = await svc.config(widgetKey);
    if (!cfg) throw new ApiError('NOT_FOUND', 'Chat not found');
    if (!(await allowed(cfg, originOf(req)))) throw new ApiError('FORBIDDEN', 'Origin not allowed');
    return cfg;
  };
  const token = (req: FastifyRequest) => {
    const v = req.headers['x-hepson-visitor'];
    return typeof v === 'string' ? v : undefined;
  };

  route(app, {
    method: 'GET',
    url: '/widget/web-chat.js',
    summary: 'The embeddable chat widget script (public)',
    tag: 'web-chat',
    auth: 'none',
    handler: ({ reply }) => {
      reply.type('application/javascript; charset=utf-8').header('cache-control', 'public, max-age=300');
      return widgetSource;
    },
  });

  route(app, {
    method: 'POST',
    url: '/public/web-chat/:widgetKey/session',
    summary: 'Start an anonymous visitor session; returns the visitor token (public, Origin-checked, rate-limited)',
    tag: 'web-chat',
    auth: 'none',
    params: keyP,
    body: sessionBody,
    status: 201,
    handler: async ({ req, params, body }) => await svc.openSession(await gate(req, params.widgetKey), req.ip, body.name),
  });

  route(app, {
    method: 'POST',
    url: '/public/web-chat/:widgetKey/messages',
    summary: 'Visitor sends a message (header x-hepson-visitor); the AI or a human answers later (public, rate-limited)',
    tag: 'web-chat',
    auth: 'none',
    params: keyP,
    body: z.strictObject({ text: z.string().trim().min(1).max(1000) }),
    status: 201,
    handler: async ({ req, params, body }) => {
      const cfg = await gate(req, params.widgetKey);
      return { message: visitorView(await svc.send(cfg, await svc.session(cfg, token(req)), req.ip, body.text)) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/public/web-chat/:widgetKey/messages',
    summary: 'Visitor reads the conversation after `afterSeq` (header x-hepson-visitor; poll every few seconds) (public)',
    tag: 'web-chat',
    auth: 'none',
    params: keyP,
    query: afterQ,
    handler: async ({ req, params, query }) => {
      const cfg = await gate(req, params.widgetKey);
      return { items: (await svc.messages(cfg, await svc.session(cfg, token(req)), query.afterSeq)).map(visitorView) };
    },
  });

  const configView = async (shopId: string) => {
    const c = await webChat.getConfig(shopId);
    const snippet = c ? `<script src="${publicUrl}/widget/web-chat.js" data-key="${c.widgetKey}" data-lang="uk" async></script>` : null;
    return { enabled: c?.enabled ?? false, widgetKey: c?.widgetKey ?? null, allowedOrigins: c?.allowedOrigins ?? [], snippet, updatedAt: c?.updatedAt ?? null };
  };
  const translate = (e: unknown): never => {
    if (e instanceof WebChatValidationError) throw new ApiError('VALIDATION_ERROR', e.message);
    throw e;
  };

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/web-chat',
    summary: 'Website chat settings and embed snippet (any member)',
    tag: 'web-chat',
    auth: 'user',
    params: shopP,
    handler: async ({ req, params }) => {
      await requireRole(req, params.shopId, 'manager');
      return await configView(params.shopId);
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/web-chat',
    summary: 'Switch the website chat on/off and set the allowed origins, e.g. https://shop.example (owner). Off and empty by default.',
    tag: 'web-chat',
    auth: 'user',
    params: shopP,
    body: configBody,
    handler: async ({ req, params, body }) => {
      await requireRole(req, params.shopId, 'owner');
      try {
        await webChat.updateConfig(params.shopId, body);
      } catch (e) {
        translate(e);
      }
      return await configView(params.shopId);
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/shops/:shopId/web-chat/rotate-key',
    summary: 'Issue a new widget key; snippets with the old key stop working at once (owner)',
    tag: 'web-chat',
    auth: 'user',
    params: shopP,
    status: 200,
    handler: async ({ req, params }) => {
      await requireRole(req, params.shopId, 'owner');
      await webChat.rotateKey(params.shopId);
      return await configView(params.shopId);
    },
  });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
