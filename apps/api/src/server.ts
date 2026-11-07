import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ApiError } from './errors';
import {
  AgentRepository,
  ApiKeyRepository,
  AuthRepository,
  CatalogRepository,
  ConversationRepository,
  CredentialVault,
  CustomerNoticeRepository,
  onCustomerNoticeQueued,
  PlanRepository,
  DeliveryRepository,
  InstagramRepository,
  Keyring,
  NotificationRepository,
  OrderRepository,
  PaymentRepository,
  PhotoIndexRepository,
  PolicyRepository,
  openDb,
  runMigrations,
  SESSION_PREFIX,
  ShopRepository,
  StatsRepository,
  TelegramRepository,
  WebChatRepository,
  type DbHandle,
} from '@hepson/database';
import { loadConfig, type Config } from './config';
import { registerAuthRoutes } from './routes/auth';
import { registerCatalogRoutes } from './routes/catalog';
import { registerConversationRoutes } from './routes/conversations';
import { registerShopRoutes } from './routes/shops';
import { SalesAgent } from './agent/sales-agent';
import { OpenAiClient, type LlmClient } from './agent/llm';
import { OpenAiVision, type VisionClient } from './agent/vision';
import { PhotoSearchService } from './services/photo-search';
import { registerPhotoSearchRoutes } from './routes/photo-search';
import { registerStorefrontRoutes } from './routes/storefront';
import { registerAiRoutes } from './routes/ai';
import { registerOrderRoutes } from './routes/orders';
import { registerStatsRoutes } from './routes/stats';
import { registerNotificationFeedRoutes } from './routes/notification-feed';
import { registerInstagramRoutes } from './routes/instagram';
import { registerTelegramRoutes } from './routes/telegram';
import { registerWebChatRoutes } from './routes/web-chat';
import { registerPolicyRoutes } from './routes/policies';
import { registerDeliveryRoutes } from './routes/delivery';
import { DeliveryService } from './services/delivery';
import { NovaPoshtaApi } from './services/nova-poshta';
import { MonobankApi } from './services/monobank';
import { PaymentService } from './services/payments';
import { CustomerNoticeService } from './services/customer-notices';
import { registerPlanRoutes } from './routes/plans';
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

export type App = {
  app: FastifyInstance;
  apiKeys: ApiKeyRepository;
  shops: ShopRepository;
  auth: AuthRepository;
  catalog: CatalogRepository;
  conversations: ConversationRepository;
  agentRepo: AgentRepository;
  orders: OrderRepository;
  stats: StatsRepository;
  feed: NotificationRepository;
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
  noticeRepo: CustomerNoticeRepository;
  notices: CustomerNoticeService;
  plans: PlanRepository;
  notifier: Notifier | null;
  salesAgent: SalesAgent | null;
  photoRepo: PhotoIndexRepository;
  photos: PhotoSearchService | null;
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

export async function buildApp(
  overrides: Partial<Config> & {
    logger?: boolean;
    llm?: LlmClient;
    notifier?: Notifier;
    keyring?: Keyring | null;
    fetchImpl?: typeof fetch;
    logStream?: NodeJS.WritableStream;
    vision?: VisionClient | null;
  } = {},
): Promise<App> {
  const cfg: Config = { ...loadConfig(), ...overrides };
  const handle = openDb(cfg.dbFile);
  runMigrations(handle);
  const apiKeys = new ApiKeyRepository(handle);
  const shops = new ShopRepository(handle);
  const auth = new AuthRepository(handle);
  const catalog = new CatalogRepository(handle);
  const conversations = new ConversationRepository(handle);
  const agentRepo = new AgentRepository(handle);
  const orders = new OrderRepository(handle);
  const stats = new StatsRepository(handle);
  const feed = new NotificationRepository(handle);
  const webChat = new WebChatRepository(handle);
  const keyring = overrides.keyring !== undefined ? overrides.keyring : Keyring.fromEnv(process.env);
  const vault = new CredentialVault(handle, keyring);
  const igRepo = new InstagramRepository(handle);
  const tgRepo = new TelegramRepository(handle);
  const policies = new PolicyRepository(handle);
  const deliveryRepo = new DeliveryRepository(handle);
  const paymentRepo = new PaymentRepository(handle);
  const noticeRepo = new CustomerNoticeRepository(handle);
  const plans = new PlanRepository(handle, cfg.defaultPlan);
  // The only outbound transport (D22): configured provider hosts are added to the built-in allow-list.
  const egress = createEgress({
    extraHosts: [
      ...cfg.egressExtraHosts.filter((h) => h.startsWith('.')),
      ...[...cfg.egressExtraHosts.filter((h) => !h.startsWith('.')), cfg.openaiBaseUrl, cfg.telegramApiBaseUrl, cfg.metaGraphBaseUrl, cfg.novaPoshtaBaseUrl, cfg.monobankBaseUrl]
        .flatMap((u) => (u ? [hostOf(u) ?? ''] : []))
        .filter(Boolean),
    ],
    fetchImpl: overrides.fetchImpl,
  });
  const app = Fastify({
    logger:
      overrides.logger === false
        ? false
        : {
            level: cfg.logLevel,
            redact: { paths: REDACT_PATHS, censor: '[redacted]' },
            serializers: { req: logReq },
            ...(overrides.logStream ? { stream: overrides.logStream } : {}),
          },
    bodyLimit: 64 * 1024,
    trustProxy: cfg.trustProxy,
  });
  const log = app.log;
  const vision =
    overrides.vision !== undefined
      ? overrides.vision
      : cfg.photoSearch && cfg.openaiApiKey && cfg.visionModel
        ? new OpenAiVision({ apiKey: cfg.openaiApiKey, model: cfg.visionModel, embeddingModel: cfg.embeddingModel, baseUrl: cfg.openaiBaseUrl, fetch: egress })
        : null;
  const llm =
    overrides.llm ??
    (cfg.openaiApiKey && cfg.openaiModel ? new OpenAiClient({ apiKey: cfg.openaiApiKey, model: cfg.openaiModel, baseUrl: cfg.openaiBaseUrl, fetch: egress }) : null);
  const notifier: Notifier | null =
    overrides.notifier ??
    (cfg.telegramBotToken
      ? new TelegramNotifier({ token: cfg.telegramBotToken, agent: agentRepo, shops, conversations, orders, log, baseUrl: cfg.telegramApiBaseUrl, fetchImpl: egress })
      : null);
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
    send: (shopId, conversationId, text) => sendSystemMessage({ conversations, ig, tg }, shopId, conversationId, text),
    log,
    publicUrl: cfg.publicUrl,
    notifier: notifier ?? undefined,
  });
  const notices = new CustomerNoticeService({
    repo: noticeRepo,
    orders,
    shops,
    send: (shopId, conversationId, text) => sendSystemMessage({ conversations, ig, tg }, shopId, conversationId, text),
    log,
    notifier: notifier ?? undefined,
  });
  // Any repository instance on this database may queue a notice (P6); the sender wakes after the transition commits.
  const stopNoticeListener = onCustomerNoticeQueued(handle, () => notices.kick());
  const photoRepo = new PhotoIndexRepository(handle);
  const photos = vision ? new PhotoSearchService({ repo: photoRepo, vision, egress, telegram: tg, log }) : null;
  const salesAgent = llm
    ? new SalesAgent({
        shops,
        conversations,
        catalog,
        orders,
        agent: agentRepo,
        policies,
        plans,
        deliveryRepo,
        delivery,
        paymentRepo,
        payments,
        llm,
        log,
        maxMessageLength: cfg.maxMessageLength,
        notifier: notifier ?? undefined,
        instagram: ig,
        telegram: tg,
        photos: photos ?? undefined,
      })
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
      const row = apiKeys.find(m[1]!);
      if (row) req.principal = { keyId: row.id };
    }
  });
  app.setErrorHandler((err, _req, reply) => {
    let ce: ApiError;
    if (err instanceof ApiError) ce = err;
    else if (err instanceof ZodError) ce = new ApiError('VALIDATION_ERROR', err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
    else if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) ce = new ApiError('VALIDATION_ERROR', (err as Error).message);
    else {
      app.log.error({ err: (err as Error).message }, 'unhandled');
      ce = new ApiError('INTERNAL', 'Internal error', { retryable: false });
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
  registerAuthRoutes(app, auth, { allowRegistration: cfg.allowRegistration, sessionTtlMs: cfg.sessionTtlDays * 86_400_000, throttle: new LoginThrottle() });
  registerShopRoutes(app, { shops, auth, handle });
  registerCatalogRoutes(app, { shops, auth, catalog, egress, onCatalogChange: () => photos?.schedule() });
  registerPhotoSearchRoutes(app, { shops, auth, photos });
  registerStorefrontRoutes(app, { shops, auth, catalog, webChat, tgRepo, igRepo, publicUrl: cfg.publicUrl });
  registerConversationRoutes(app, { shops, auth, conversations, maxMessageLength: cfg.maxMessageLength, ig, tg });
  registerAiRoutes(app, { shops, auth, agent: agentRepo, aiAvailable: salesAgent !== null, telegramAvailable: notifier !== null });
  registerStatsRoutes(app, { shops, auth, stats, plans });
  registerNotificationFeedRoutes(app, { shops, auth, feed });
  registerPlanRoutes(app, { shops, auth, plans });
  registerWebChatRoutes(app, { shops, auth, webChat, svc: webChatSvc, publicUrl: cfg.publicUrl });
  registerOrderRoutes(app, { shops, auth, orders, delivery, payments, paymentRepo, noticeRepo });
  registerPolicyRoutes(app, { shops, auth, policies });
  registerDeliveryRoutes(app, { shops, auth, delivery, deliveryRepo, orders, conversations });
  registerTelegramRoutes(app, { shops, auth, tg });
  await registerPaymentRoutes(app, { shops, auth, payments, paymentRepo });
  await registerInstagramRoutes(app, { shops, auth, ig, appSecret: cfg.metaAppSecret, verifyToken: cfg.metaVerifyToken, dashboardUrl: cfg.dashboardUrl });
  const spec = buildOpenApi(registry);
  app.get('/v1/openapi.json', async () => spec);

  notices.start();
  agentRepo.failInterruptedRuns();
  const timer = setInterval(() => {
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
  const photoTimer = photos && cfg.photoIndexMinutes > 0 ? setInterval(() => photos.schedule(), cfg.photoIndexMinutes * 60_000) : null;
  photoTimer?.unref();
  photos?.schedule();

  let closed = false;
  return {
    app,
    apiKeys,
    shops,
    auth,
    catalog,
    conversations,
    agentRepo,
    orders,
    stats,
    feed,
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
    noticeRepo,
    notices,
    plans,
    notifier,
    salesAgent,
    photoRepo,
    photos,
    handle,
    cfg,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (pollTimer) clearInterval(pollTimer);
      if (npTimer) clearInterval(npTimer);
      if (payTimer) clearInterval(payTimer);
      if (photoTimer) clearInterval(photoTimer);
      await salesAgent?.whenIdle();
      await ig.whenIdle();
      await payments.whenIdle();
      await delivery.whenIdle();
      await photos?.whenIdle();
      stopNoticeListener();
      await notices.whenIdle();
      notices.stop();
      await notifier?.whenIdle();
      await app.close();
      handle.close();
    },
  };
}
