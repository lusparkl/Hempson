import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import { AgentRepository, AuthRepository, CatalogRepository, ConversationRepository, CredentialVault, DeliveryRepository, InstagramRepository, Keyring, OrderRepository, PaymentRepository, PolicyRepository, openDb, runMigrations, SESSION_PREFIX, ShopRepository, StatsRepository, Store, TelegramRepository, WebChatRepository, type DbHandle } from '@hepson/database';
import { MockAdapter } from '@hepson/mock-adapter';
import { BrowserInstagramAdapter } from '@hepson/instagram-browser';
import { loadConfig, type Config } from './config';
import { registerAccountRoutes } from './routes/accounts';
import { registerAuthRoutes } from './routes/auth';
import { ChannelBridge } from './services/channel-bridge';
import { registerCatalogRoutes } from './routes/catalog';
import { registerChannelRoutes } from './routes/channels';
import { registerConversationRoutes } from './routes/conversations';
import { registerShopRoutes } from './routes/shops';
import { SalesAgent } from './agent/sales-agent';
import { OpenAiClient, type LlmClient } from './agent/llm';
import { registerAiRoutes } from './routes/ai';
import { registerOrderRoutes } from './routes/orders';
import { registerStatsRoutes } from './routes/stats';
import { registerInstagramRoutes } from './routes/instagram';
import { registerTelegramRoutes } from './routes/telegram';
import { registerWebChatRoutes } from './routes/web-chat';
import { registerPolicyRoutes } from './routes/policies';
import { registerDeliveryRoutes } from './routes/delivery';
import { DeliveryService } from './services/delivery';
import { NovaPoshtaApi } from './services/nova-poshta';
import { MonobankApi } from './services/monobank';
import { PaymentService } from './services/payments';
import { registerPaymentRoutes } from './routes/payments';
import { sendSystemMessage } from './services/shop-sender';
import { createEgress, hostOf } from './services/egress';
import { InstagramService } from './services/instagram';
import { InstagramGraph } from './services/instagram-graph';
import { RateLimitedError, WebChatService } from './services/web-chat';
import { TelegramNotifier, type Notifier } from './services/notifier';
import { TelegramService } from './services/telegram';
import { TelegramBotApi } from './services/telegram-bot';
import { LoginThrottle } from './auth/throttle';
import { registry, route } from './routes/define';
import { buildOpenApi } from './openapi';
import { ConnectorService, type AdapterRegistry } from './services/connector-service';
import { EventBus } from './services/event-bus';
import { ProfileAdmin } from './services/profile-admin';

export type App = {
  app: FastifyInstance;
  svc: ConnectorService;
  store: Store;
  shops: ShopRepository;
  auth: AuthRepository;
  catalog: CatalogRepository;
  conversations: ConversationRepository;
  agentRepo: AgentRepository;
  orders: OrderRepository;
  stats: StatsRepository;
  webChat: WebChatRepository;
  vault: CredentialVault;
  igRepo: InstagramRepository;
  ig: InstagramService;
  tgRepo: TelegramRepository;
  tg: TelegramService;
  policies: PolicyRepository;
  deliveryRepo: DeliveryRepository;
  delivery: DeliveryService;
  paymentRepo: PaymentRepository;
  payments: PaymentService;
  notifier: Notifier | null;
  salesAgent: SalesAgent | null;
  mock: MockAdapter;
  handle: DbHandle;
  cfg: Config;
  close(): Promise<void>;
};

/** Same fields as Fastify's default request log, with one-time OAuth `code`/`state` and the webhook verify token removed from the URL. */
function logReq(r: { method?: string; url?: string; host?: string; ip?: string; socket?: { remotePort?: number } }) {
  const url = r.url?.replace(/([?&])([^=&]+)=[^&]*/g, (parameter, separator: string, key: string) => {
    const decodedKey = new URLSearchParams(`${key}=`).keys().next().value;
    return decodedKey && ['code', 'state', 'hub.verify_token'].includes(decodedKey) ? `${separator}${key}=[redacted]` : parameter;
  });
  return { method: r.method, url, host: r.host, remoteAddress: r.ip, remotePort: r.socket?.remotePort };
}

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.cookie',
  '*.cookies',
  '*.token',
  '*.accessToken',
  '*.access_token',
  '*.appSecret',
  '*.client_secret',
  '*.masterKey',
  '*.secret',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-telegram-bot-api-secret-token"]',
  'req.headers["x-token"]',
  'req.headers["x-sign"]',
  '*.apiKey',
  '*.key',
  '*.text',
  '*.body',
];

export async function buildApp(overrides: Partial<Config> & { adapters?: Partial<AdapterRegistry>; logger?: boolean; llm?: LlmClient; notifier?: Notifier; keyring?: Keyring | null; fetchImpl?: typeof fetch; logStream?: NodeJS.WritableStream } = {}): Promise<App> {
  const cfg: Config = { ...loadConfig(), ...overrides };
  const handle = openDb(cfg.dbFile);
  runMigrations(handle);
  const store = new Store(handle);
  const shops = new ShopRepository(handle);
  const auth = new AuthRepository(handle);
  const catalog = new CatalogRepository(handle);
  const conversations = new ConversationRepository(handle);
  const agentRepo = new AgentRepository(handle);
  const orders = new OrderRepository(handle);
  const stats = new StatsRepository(handle);
  const webChat = new WebChatRepository(handle);
  const keyring = overrides.keyring !== undefined ? overrides.keyring : Keyring.fromEnv(process.env);
  const vault = new CredentialVault(handle, keyring);
  const igRepo = new InstagramRepository(handle);
  const tgRepo = new TelegramRepository(handle);
  const policies = new PolicyRepository(handle);
  const deliveryRepo = new DeliveryRepository(handle);
  const paymentRepo = new PaymentRepository(handle);
  // The only outbound transport (D22): configured provider hosts are added to the built-in allow-list.
  const egress = createEgress({
    extraHosts: [...cfg.egressExtraHosts, cfg.openaiBaseUrl, cfg.telegramApiBaseUrl, cfg.metaGraphBaseUrl, cfg.novaPoshtaBaseUrl, cfg.monobankBaseUrl].flatMap((u) => (u ? [hostOf(u) ?? ''] : [])).filter(Boolean),
    fetchImpl: overrides.fetchImpl,
  });
  const bus = new EventBus(store);
  const mock = new MockAdapter();
  const adapters: AdapterRegistry = {
    mock,
    // Frozen and deprecated (D22): not even constructed unless HEPSON_ENABLE_BROWSER_ADAPTER is set.
    'instagram-browser': cfg.enableBrowserAdapter
      ? new BrowserInstagramAdapter({
          dataDir: cfg.dataDir,
          baseUrl: cfg.instagramBaseUrl,
          headless: cfg.browserHeadless,
          loginWaitMs: cfg.loginWaitMs,
          maxConcurrent: cfg.maxConcurrentBrowsers,
        })
      : undefined,
    'instagram-official': undefined,
    ...overrides.adapters,
  };
  const app = Fastify({
    logger: overrides.logger === false ? false : { level: cfg.logLevel, redact: { paths: REDACT_PATHS, censor: '[redacted]' }, serializers: { req: logReq }, ...(overrides.logStream ? { stream: overrides.logStream } : {}) },
    bodyLimit: 64 * 1024,
    trustProxy: cfg.trustProxy,
  });
  const log = app.log;
  const bridge = new ChannelBridge(store, conversations, log);
  const svc = new ConnectorService(store, bus, adapters, cfg, log, bridge);
  const profiles = new ProfileAdmin(cfg.dataDir);
  const llm = overrides.llm ?? (cfg.openaiApiKey && cfg.openaiModel ? new OpenAiClient({ apiKey: cfg.openaiApiKey, model: cfg.openaiModel, baseUrl: cfg.openaiBaseUrl, fetch: egress }) : null);
  const notifier: Notifier | null =
    overrides.notifier ?? (cfg.telegramBotToken ? new TelegramNotifier({ token: cfg.telegramBotToken, agent: agentRepo, shops, conversations, log, baseUrl: cfg.telegramApiBaseUrl, fetchImpl: egress }) : null);
  const ig = new InstagramService({
    graph: new InstagramGraph(
      {
        appId: cfg.metaAppId ?? '',
        appSecret: cfg.metaAppSecret ?? '',
        configId: cfg.metaConfigId ?? '',
        apiVersion: cfg.metaApiVersion,
        graphBaseUrl: cfg.metaGraphBaseUrl,
        authorizeUrl: cfg.metaAuthorizeUrl,
      },
      egress,
    ),
    vault,
    repo: igRepo,
    conversations,
    log,
    publicUrl: cfg.publicUrl,
    appConfigured: !!(cfg.metaAppId && cfg.metaAppSecret && cfg.metaVerifyToken && cfg.metaConfigId),
    onInbound: (shopId, conversationId, messageId) => salesAgent?.trigger(shopId, conversationId, messageId),
    notifier: notifier ?? undefined,
  });
  // Shop bots (D27) share only the API base URL with the operator notifier bot, never its token.
  const tg = new TelegramService({
    api: new TelegramBotApi(egress, cfg.telegramApiBaseUrl),
    vault,
    repo: tgRepo,
    conversations,
    log,
    publicUrl: cfg.publicUrl,
    onInbound: (shopId, conversationId, messageId) => salesAgent?.trigger(shopId, conversationId, messageId),
    notifier: notifier ?? undefined,
  });
  const delivery = new DeliveryService({ api: new NovaPoshtaApi(egress, cfg.novaPoshtaBaseUrl), vault, repo: deliveryRepo, orders, log, notifier: notifier ?? undefined });
  const payments = new PaymentService({
    api: new MonobankApi(egress, cfg.monobankBaseUrl),
    vault,
    repo: paymentRepo,
    orders,
    agent: agentRepo,
    shops,
    delivery,
    send: (shopId, conversationId, text, key) => sendSystemMessage({ store, svc, conversations, ig, tg }, shopId, conversationId, text, key),
    log,
    publicUrl: cfg.publicUrl,
    notifier: notifier ?? undefined,
  });
  const salesAgent = llm
    ? new SalesAgent({ store, bus, svc, shops, conversations, catalog, orders, agent: agentRepo, policies, deliveryRepo, delivery, paymentRepo, payments, llm, log, maxMessageLength: cfg.maxMessageLength, notifier: notifier ?? undefined, instagram: ig, telegram: tg })
    : null;

  const webChatSvc = new WebChatService(
    webChat,
    conversations,
    {
      sessionsPerIpPerHour: cfg.webChatSessionsPerIpPerHour,
      messagesPerSessionPerMinute: cfg.webChatMessagesPerSessionPerMinute,
      messagesPerIpPerMinute: cfg.webChatMessagesPerIpPerMinute,
      dailyMessagesPerShop: cfg.webChatDailyMessagesPerShop,
      sessionTtlMs: cfg.webChatSessionDays * 86_400_000,
      maxMessageLength: cfg.maxMessageLength,
    },
    (shopId, conversationId, messageId) => salesAgent?.trigger(shopId, conversationId, messageId),
  );

  // API and public chat answers are per-user or per-visitor: never cache them, never let a browser sniff types.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    if ((req.url.startsWith('/v1/') || req.url.startsWith('/public/')) && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'no-referrer');
  });
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    const m = h && /^Bearer\s+(\S+)$/i.exec(h);
    if (m && m[1]!.startsWith(SESSION_PREFIX)) {
      const s = auth.findSession(m[1]!);
      if (s) req.user = s;
    } else if (m) {
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
    if (ce instanceof RateLimitedError) reply.header('retry-after', String(ce.retryAfterSec));
    reply.status(ce.httpStatus).send(ce.toJSON());
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', retryable: false } }));

  route(app, {
    method: 'GET',
    url: '/ready',
    summary: 'Readiness: the database answers',
    tag: 'meta',
    auth: 'none',
    handler: ({ reply }) => {
      try {
        handle.raw.prepare('select 1').get();
        return { ok: true };
      } catch {
        reply.status(503);
        return { ok: false };
      }
    },
  });
  route(app, { method: 'GET', url: '/health', summary: 'Liveness', tag: 'meta', auth: 'none', handler: () => ({ ok: true, time: new Date().toISOString() }) });
  registerAccountRoutes(app, svc, profiles, { retentionDays: cfg.retentionDays, enableDev: cfg.enableDevRoutes, maxMessageLength: cfg.maxMessageLength, browserAdapter: cfg.enableBrowserAdapter });
  registerAuthRoutes(app, auth, { allowRegistration: cfg.allowRegistration, sessionTtlMs: cfg.sessionTtlDays * 86_400_000, throttle: new LoginThrottle() });
  registerShopRoutes(app, { shops, auth, handle });
  registerCatalogRoutes(app, { shops, auth, catalog });
  registerConversationRoutes(app, { shops, auth, conversations, store, svc, maxMessageLength: cfg.maxMessageLength, ig, tg });
  registerChannelRoutes(app, { store, shops, auth, bridge });
  registerAiRoutes(app, { shops, auth, agent: agentRepo, aiAvailable: salesAgent !== null, telegramAvailable: notifier !== null });
  registerStatsRoutes(app, { shops, auth, stats });
  registerWebChatRoutes(app, { shops, auth, webChat, svc: webChatSvc, publicUrl: cfg.publicUrl });
  registerOrderRoutes(app, { shops, auth, orders, delivery, payments, paymentRepo });
  registerPolicyRoutes(app, { shops, auth, policies });
  registerDeliveryRoutes(app, { shops, auth, delivery, deliveryRepo, orders, conversations });
  registerTelegramRoutes(app, { shops, auth, tg });
  await registerPaymentRoutes(app, { shops, auth, payments, paymentRepo });
  await registerInstagramRoutes(app, { shops, auth, ig, appSecret: cfg.metaAppSecret, verifyToken: cfg.metaVerifyToken, dashboardUrl: cfg.dashboardUrl });
  const spec = buildOpenApi(registry);
  app.get('/v1/openapi.json', async () => spec);

  svc.recoverInterruptedSends();
  agentRepo.failInterruptedRuns();
  salesAgent?.start();
  bridge.backfillAll();
  const timer = setInterval(() => {
    for (const a of store.listAccounts()) store.purgeOlderThan(a.id, cfg.retentionDays);
    webChat.purgeExpiredSessions();
    auth.purgeDeadSessions();
    igRepo.purgeExpiredStates();
    void ig.expireDue().catch(() => undefined);
  }, 6 * 3600_000);
  timer.unref();
  void ig.expireDue().catch(() => undefined);
  const pollTimer = cfg.instagramPollSeconds > 0 ? setInterval(() => void ig.pollOnce().catch(() => undefined), cfg.instagramPollSeconds * 1000) : null;
  pollTimer?.unref();
  const npTimer = cfg.novaPoshtaPollMinutes > 0 ? setInterval(() => void delivery.pollOnce().catch(() => undefined), cfg.novaPoshtaPollMinutes * 60_000) : null;
  npTimer?.unref();
  const payTimer = cfg.paymentCheckMinutes > 0 ? setInterval(() => void payments.reconcileOnce().catch(() => undefined), cfg.paymentCheckMinutes * 60_000) : null;
  payTimer?.unref();

  let closed = false;
  return {
    app,
    svc,
    store,
    shops,
    auth,
    catalog,
    conversations,
    agentRepo,
    orders,
    stats,
    webChat,
    vault,
    igRepo,
    ig,
    tgRepo,
    tg,
    policies,
    deliveryRepo,
    delivery,
    paymentRepo,
    payments,
    notifier,
    salesAgent,
    mock,
    handle,
    cfg,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (pollTimer) clearInterval(pollTimer);
      if (npTimer) clearInterval(npTimer);
      if (payTimer) clearInterval(payTimer);
      salesAgent?.stop();
      await salesAgent?.whenIdle();
      await ig.whenIdle();
      await payments.whenIdle();
      await delivery.whenIdle();
      await notifier?.whenIdle();
      await svc.shutdown();
      await app.close();
      handle.close();
    },
  };
}
