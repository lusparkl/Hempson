import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors';
import type { UserRow } from '@hepson/database';
import type { z } from 'zod';

export type Principal = { keyId: string };
export type SessionUser = { sessionId: string; user: UserRow };
declare module 'fastify' {
  interface FastifyRequest {
    /** Operator API key (`hep_…`). */
    principal?: Principal;
    /** Dashboard user session (`hsu_…`). */
    user?: SessionUser;
  }
}

export type RouteDef<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType> = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  summary: string;
  tag: string;
  /** none = public; admin = operator API key; user = dashboard user session (API keys are rejected) */
  auth: 'none' | 'admin' | 'user';
  params?: P;
  query?: Q;
  body?: B;
  status?: number;
  /** Overrides the server-wide body limit (bytes) for this route only. */
  bodyLimit?: number;
  responseExample?: unknown;
  handler: (ctx: { req: FastifyRequest; reply: FastifyReply; params: z.infer<P>; query: z.infer<Q>; body: z.infer<B>; principal: Principal | null }) => Promise<unknown> | unknown;
};

export const registry: Array<RouteDef<z.ZodType, z.ZodType, z.ZodType>> = [];

function parse<T extends z.ZodType>(schema: T | undefined, value: unknown, where: string): z.infer<T> {
  if (!schema) return undefined as z.infer<T>;
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new ApiError('VALIDATION_ERROR', `${where}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  return r.data;
}

export function route<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType>(app: FastifyInstance, def: RouteDef<P, Q, B>) {
  registry.push(def as unknown as RouteDef<z.ZodType, z.ZodType, z.ZodType>);
  app.route({
    method: def.method,
    url: def.url,
    ...(def.bodyLimit ? { bodyLimit: def.bodyLimit } : {}),
    handler: async (req, reply) => {
      const principal = req.principal ?? null;
      const params = parse(def.params, req.params, 'params');
      if (def.auth === 'user') {
        if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing or invalid session token');
      } else if (def.auth === 'admin' && !principal) {
        throw new ApiError('UNAUTHORIZED', 'Missing or invalid API key');
      }
      const query = parse(def.query, req.query, 'query');
      const body = parse(def.body, req.body, 'body');
      reply.status(def.status ?? 200);
      return def.handler({ req, reply, params, query, body, principal });
    },
  });
}
