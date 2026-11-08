import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogRepository } from '@hepson/database';
import { ApiError } from '../errors';
import { LlmError } from '../agent/llm';
import type { SalesAgent } from '../agent/sales-agent';
import { RateLimitedError } from '../services/web-chat';
import { RateLimiter } from '../services/rate-limit';
import { route } from './define';
import { playgroundMessages } from './ai';

const CORS_PREFIX = /^\/public\/demo(?:[/?#]|$)/;
const DAY_MS = 86_400_000;
const chatBody = z.strictObject({ messages: playgroundMessages(500, 20) });

/**
 * Public agent demo on the marketing site (D45): the sandboxed playground over the seeded demo shop. Each turn costs the
 * operator model tokens, so it is off by default and limited per IP and per day. `Origin` keeps other sites' browsers out; it is not authentication.
 */
export function registerDemoRoutes(
  app: FastifyInstance,
  deps: { shopId: string | null; catalog: CatalogRepository; salesAgent: SalesAgent | null; origins: string[]; turnsPerIpPerHour: number; turnsPerDay: number },
) {
  const { shopId, catalog, salesAgent } = deps;
  const origins = new Set(deps.origins.map((o) => o.toLowerCase()));
  const perIp = new RateLimiter(deps.turnsPerIpPerHour, 3_600_000);
  const perDay = new RateLimiter(deps.turnsPerDay, DAY_MS);

  app.addHook('onRequest', async (req, reply) => {
    if (!CORS_PREFIX.test(req.url)) return;
    const origin = req.headers.origin;
    const ok = !!origin && origins.has(origin.toLowerCase());
    if (ok) {
      reply
        .header('access-control-allow-origin', origin)
        .header('vary', 'Origin')
        .header('access-control-allow-headers', 'content-type')
        .header('access-control-allow-methods', 'GET, POST, OPTIONS')
        .header('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') return reply.code(ok ? 204 : 403).send();
  });

  route(app, {
    method: 'GET',
    url: '/public/demo',
    summary: 'Whether the website demo is on, and its test products (public)',
    tag: 'demo',
    auth: 'none',
    handler: () => {
      if (!shopId || !salesAgent) return { available: false, products: [] };
      const products = catalog
        .listProducts(shopId, { active: true, limit: 20 })
        .items.map(({ product: p }) => ({ name: p.name, description: p.description, priceMinor: p.priceMinor, currency: p.currency }));
      return { available: true, products };
    },
  });

  route(app, {
    method: 'POST',
    url: '/public/demo/chat',
    summary: 'One turn with the sales agent over the test catalog; the page keeps the conversation and nothing is stored or sent (public, Origin-checked, rate-limited)',
    tag: 'demo',
    auth: 'none',
    body: chatBody,
    handler: async ({ req, body }) => {
      if (!shopId || !salesAgent) throw new ApiError('NOT_CONFIGURED', 'The demo is off on this server');
      if (!origins.has(req.headers.origin?.toLowerCase() ?? '')) throw new ApiError('FORBIDDEN', 'Origin not allowed');
      const wait = perIp.hit(req.ip) || perDay.hit('all');
      if (wait) throw new RateLimitedError(wait);
      try {
        const r = await salesAgent.playground(shopId, { messages: body.messages });
        return { outcome: r.outcome, reply: r.reply, checks: [...new Set(r.tools.map((t) => t.name))] };
      } catch (e) {
        if (e instanceof LlmError) throw new ApiError('TEMPORARY_FAILURE', 'The AI model did not answer, try again');
        throw e;
      }
    },
  });
}
