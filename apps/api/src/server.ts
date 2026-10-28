import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import { openDb, runMigrations, Store, type DbHandle } from '@hepson/database';
import { MockAdapter } from '@hepson/mock-adapter';
import { BrowserInstagramAdapter } from '@hepson/instagram-browser';
import { loadConfig, type Config } from './config';
import { registerAccountRoutes } from './routes/accounts';
import { registry, route } from './routes/define';
import { buildOpenApi } from './openapi';
import { ConnectorService, type AdapterRegistry } from './services/connector-service';
import { EventBus } from './services/event-bus';
import { ProfileAdmin } from './services/profile-admin';

export type App = { app: FastifyInstance; svc: ConnectorService; store: Store; mock: MockAdapter; handle: DbHandle; cfg: Config; close(): Promise<void> };

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.cookie',
  '*.cookies',
  '*.token',
  '*.accessToken',
  '*.apiKey',
  '*.key',
  '*.text',
  '*.body',
];

export async function buildApp(overrides: Partial<Config> & { adapters?: Partial<AdapterRegistry>; logger?: boolean } = {}): Promise<App> {
  const cfg: Config = { ...loadConfig(), ...overrides };
  const handle = openDb(cfg.dbFile);
  runMigrations(handle);
  const store = new Store(handle);
  const bus = new EventBus(store);
  const mock = new MockAdapter();
  const adapters: AdapterRegistry = {
    mock,
    'instagram-browser': new BrowserInstagramAdapter({
      dataDir: cfg.dataDir,
      baseUrl: cfg.instagramBaseUrl,
      headless: cfg.browserHeadless,
      loginWaitMs: cfg.loginWaitMs,
      maxConcurrent: cfg.maxConcurrentBrowsers,
    }),
    'instagram-official': undefined,
    ...overrides.adapters,
  };
  const app = Fastify({
    logger: overrides.logger === false ? false : { level: cfg.logLevel, redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    bodyLimit: 64 * 1024,
  });
  const log = app.log;
  const svc = new ConnectorService(store, bus, adapters, cfg, log);
  const profiles = new ProfileAdmin(cfg.dataDir);

  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    const m = h && /^Bearer\s+(\S+)$/i.exec(h);
    if (m) {
      const row = store.findApiKey(m[1]!);
      if (row) req.principal = { keyId: row.id, accountId: row.accountId };
    }
  });
  app.setErrorHandler((err, _req, reply) => {
    let ce: ConnectorError;
    if (err instanceof ConnectorError) ce = err;
    else if (err instanceof ZodError) ce = new ConnectorError('VALIDATION_ERROR', err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
    else if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) ce = new ConnectorError('VALIDATION_ERROR', (err as Error).message);
    else {
      app.log.error({ err: (err as Error).message }, 'unhandled');
      ce = new ConnectorError('INTERNAL', 'Internal error', { retryable: false });
    }
    if (reply.sent) return;
    reply.status(ce.httpStatus).send(ce.toJSON());
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', retryable: false } }));

  route(app, { method: 'GET', url: '/health', summary: 'Liveness', tag: 'meta', auth: 'none', handler: () => ({ ok: true, time: new Date().toISOString() }) });
  registerAccountRoutes(app, svc, profiles, { retentionDays: cfg.retentionDays, enableDev: cfg.enableDevRoutes, maxMessageLength: cfg.maxMessageLength });
  const spec = buildOpenApi(registry);
  app.get('/v1/openapi.json', async () => spec);

  svc.recoverInterruptedSends();
  const timer = setInterval(() => {
    for (const a of store.listAccounts()) store.purgeOlderThan(a.id, cfg.retentionDays);
  }, 6 * 3600_000);
  timer.unref();

  let closed = false;
  return {
    app,
    svc,
    store,
    mock,
    handle,
    cfg,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await svc.shutdown();
      await app.close();
      handle.close();
    },
  };
}
