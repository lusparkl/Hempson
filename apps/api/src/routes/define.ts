import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ConnectorError } from '@hepson/connector-core';
import type { z } from 'zod';

export type Principal = { keyId: string; accountId: string | null };
declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export type RouteDef<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType> = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  summary: string;
  tag: string;
  /** none = public; admin = key with no account scope; account = admin or key scoped to :accountId */
  auth: 'none' | 'any' | 'admin' | 'account';
  params?: P;
  query?: Q;
  body?: B;
  status?: number;
  responseExample?: unknown;
  handler: (ctx: { req: FastifyRequest; reply: FastifyReply; params: z.infer<P>; query: z.infer<Q>; body: z.infer<B>; principal: Principal | null }) => Promise<unknown> | unknown;
};

export const registry: Array<RouteDef<z.ZodType, z.ZodType, z.ZodType>> = [];

function parse<T extends z.ZodType>(schema: T | undefined, value: unknown, where: string): z.infer<T> {
  if (!schema) return undefined as z.infer<T>;
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new ConnectorError('VALIDATION_ERROR', `${where}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  return r.data;
}

export function route<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType>(app: FastifyInstance, def: RouteDef<P, Q, B>) {
  registry.push(def as unknown as RouteDef<z.ZodType, z.ZodType, z.ZodType>);
  app.route({
    method: def.method,
    url: def.url,
    handler: async (req, reply) => {
      const principal = req.principal ?? null;
      const params = parse(def.params, req.params, 'params');
      if (def.auth !== 'none') {
        if (!principal) throw new ConnectorError('UNAUTHORIZED', 'Missing or invalid API key');
        if (def.auth === 'admin' && principal.accountId !== null) throw new ConnectorError('FORBIDDEN', 'Admin key required');
        if (def.auth === 'account') {
          const id = (params as { accountId?: string }).accountId;
          if (principal.accountId !== null && principal.accountId !== id) throw new ConnectorError('FORBIDDEN', 'API key is not valid for this account');
        }
      }
      const query = parse(def.query, req.query, 'query');
      const body = parse(def.body, req.body, 'body');
      reply.status(def.status ?? 200);
      return def.handler({ req, reply, params, query, body, principal });
    },
  });
}
