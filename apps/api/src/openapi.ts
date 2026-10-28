import { z } from 'zod';
import type { RouteDef } from './routes/define';

type AnyDef = RouteDef<z.ZodType, z.ZodType, z.ZodType>;

function paramsOf(schema: z.ZodType | undefined, where: 'path' | 'query') {
  if (!schema) return [];
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, unknown>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([name, sch]) => ({ name, in: where, required: where === 'path' || (js.required ?? []).includes(name), schema: sch }));
}

export function buildOpenApi(defs: AnyDef[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const d of defs) {
    const url = d.url.replace(/:(\w+)/g, '{$1}');
    const op: Record<string, unknown> = {
      summary: d.summary,
      tags: [d.tag],
      parameters: [...paramsOf(d.params, 'path'), ...paramsOf(d.query, 'query')],
      security: d.auth === 'none' ? [] : [{ bearer: [] }],
      responses: {
        [String(d.status ?? 200)]: { description: 'OK' },
        default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
    if (d.body) op.requestBody = { required: true, content: { 'application/json': { schema: z.toJSONSchema(d.body, { io: 'input', unrepresentable: 'any' }) } } };
    (paths[url] ??= {})[d.method.toLowerCase()] = op;
  }
  paths['/v1/accounts/{accountId}/events/stream'] = {
    get: {
      summary: 'Server-sent events; supports afterSequence / Last-Event-ID replay',
      tags: ['events'],
      security: [{ bearer: [] }],
      parameters: [
        { name: 'accountId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'afterSequence', in: 'query', schema: { type: 'integer' } },
      ],
      responses: { '200': { description: 'text/event-stream' } },
    },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Hepson Instagram Connector API', version: '1.0.0', description: 'Provider-agnostic DM connector. Browser adapter is experimental.' },
    servers: [{ url: 'http://127.0.0.1:8787' }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'retryable'],
              properties: { code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } },
            },
          },
        },
      },
    },
    paths,
  };
}
