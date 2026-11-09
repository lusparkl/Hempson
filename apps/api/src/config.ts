import os from 'node:os';
import path from 'node:path';
import { PLAN_NAMES, type PlanName } from '@hepson/database';

export type Config = ReturnType<typeof loadConfig>;

const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : ['1', 'true', 'yes'].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
function planName(v: string | undefined): PlanName {
  if (!v) return 'starter';
  if (!(PLAN_NAMES as string[]).includes(v)) throw new Error(`HEPSON_DEFAULT_PLAN must be one of ${PLAN_NAMES.join(', ')}`);
  return v as PlanName;
}

/** `~` and `~/x` mean the home directory, as in .env.example. Env files are not shell-expanded, so `~` would otherwise become a folder in the working directory. */
const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = path.resolve(expandHome(env.HEPSON_DATA_DIR ?? path.join(os.homedir(), '.hepson')));
  return {
    dataDir,
    dbFile: path.resolve(env.HEPSON_DB_FILE ? expandHome(env.HEPSON_DB_FILE) : path.join(dataDir, 'hepson.db')),
    host: env.HEPSON_HOST ?? '127.0.0.1',
    port: int(env.HEPSON_PORT, 8787),
    logLevel: env.HEPSON_LOG_LEVEL ?? 'info',
    maxMessageLength: int(env.HEPSON_MAX_MESSAGE_LENGTH, 1000),
    /** Dashboard users may self-register (creates a user only; no shop access). */
    allowRegistration: bool(env.HEPSON_ALLOW_REGISTRATION, true),
    sessionTtlDays: int(env.HEPSON_SESSION_TTL_DAYS, 30),
    /** Sales agent (Feature 6). The agent is inactive unless both key and model are set. Never log the key. */
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    openaiModel: env.HEPSON_OPENAI_MODEL || undefined,
    openaiBaseUrl: env.HEPSON_OPENAI_BASE_URL || undefined,
    /** P9 photo search (D42): on when the OpenAI key is set and a vision-capable model is known (defaults to the agent model). */
    photoSearch: bool(env.HEPSON_PHOTO_SEARCH, true),
    visionModel: env.HEPSON_VISION_MODEL || env.HEPSON_OPENAI_MODEL || undefined,
    embeddingModel: env.HEPSON_EMBEDDING_MODEL || 'text-embedding-3-small',
    /** How often products without a current photo index entry are indexed (0 = only after catalog changes). */
    photoIndexMinutes: int(env.HEPSON_PHOTO_INDEX_MINUTES, 10),
    /** Telegram notifications (Feature 8). One shared bot; each shop sets its own chat id. Never log the token. */
    telegramBotToken: env.HEPSON_TELEGRAM_BOT_TOKEN || undefined,
    telegramApiBaseUrl: env.HEPSON_TELEGRAM_API_BASE_URL || undefined,
    /** Public base URL of this API as embedded in the website chat snippet. */
    publicUrl: (env.HEPSON_PUBLIC_URL || `http://${env.HEPSON_HOST ?? '127.0.0.1'}:${int(env.HEPSON_PORT, 8787)}`).replace(/\/+$/, ''),
    /** Honour X-Forwarded-For (set only behind a reverse proxy you control; otherwise every visitor looks like the proxy). */
    trustProxy: bool(env.HEPSON_TRUST_PROXY, false),
    /** Operator alerts (D49): off unless a chat and a bot are known. Defaults to the notification bot; a separate bot keeps alerts working if that token is revoked. Never log the token. */
    alertChatId: env.HEPSON_ALERT_TELEGRAM_CHAT_ID || undefined,
    alertBotToken: env.HEPSON_ALERT_TELEGRAM_BOT_TOKEN || env.HEPSON_TELEGRAM_BOT_TOKEN || undefined,
    alertCheckSeconds: Math.max(5, int(env.HEPSON_ALERT_CHECK_SECONDS, 30)),
    /** How often an open outage is repeated (0 = once only). */
    alertRemindMinutes: int(env.HEPSON_ALERT_REMIND_MINUTES, 60),
    alertDiskFreeMb: int(env.HEPSON_ALERT_DISK_FREE_MB, 1024),
    /** Other https addresses of this deployment to watch, such as the marketing site (comma separated). */
    alertUrls: (env.HEPSON_ALERT_URLS ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    /** Website chat abuse limits (Feature 10). */
    webChatSessionsPerIpPerHour: int(env.HEPSON_WEBCHAT_SESSIONS_PER_IP_HOUR, 20),
    webChatMessagesPerSessionPerMinute: int(env.HEPSON_WEBCHAT_MESSAGES_PER_SESSION_MINUTE, 10),
    webChatMessagesPerIpPerMinute: int(env.HEPSON_WEBCHAT_MESSAGES_PER_IP_MINUTE, 40),
    webChatDailyMessagesPerShop: int(env.HEPSON_WEBCHAT_DAILY_MESSAGES_PER_SHOP, 2000),
    webChatSessionDays: int(env.HEPSON_WEBCHAT_SESSION_DAYS, 30),
    /** Password reset email (D46). Off unless both host and from are set; the operator can still issue links with `pnpm reset-link`. Never log the password. */
    smtp:
      env.HEPSON_SMTP_HOST && env.HEPSON_SMTP_FROM
        ? {
            host: env.HEPSON_SMTP_HOST,
            port: int(env.HEPSON_SMTP_PORT, 587),
            user: env.HEPSON_SMTP_USER || undefined,
            password: env.HEPSON_SMTP_PASSWORD || undefined,
            from: env.HEPSON_SMTP_FROM,
          }
        : null,
    /** Public agent demo on the marketing site (D45). Off by default: every turn costs model tokens. Origins = exact site origins, comma separated. */
    demo: bool(env.HEPSON_DEMO, false),
    demoOrigins: (env.HEPSON_DEMO_ORIGINS ?? 'http://127.0.0.1:5175,http://localhost:5175')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    demoTurnsPerIpPerHour: int(env.HEPSON_DEMO_TURNS_PER_IP_HOUR, 20),
    demoTurnsPerDay: int(env.HEPSON_DEMO_TURNS_PER_DAY, 300),
    /** Extra outbound hosts beyond the built-in allow-list (comma separated). The LLM and Telegram base URL hosts are added automatically. An entry starting with a dot (`.cdninstagram.com`) allows `<one label>.<that suffix>`. */
    egressExtraHosts: (env.HEPSON_EGRESS_EXTRA_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    /** Operator-level Meta app (D23, D29): the app's own id and secret (not an Instagram app id). Webhooks and the connect flow are off unless id, secret, verify token and config id are set. Never log the secret. */
    metaAppId: env.HEPSON_META_APP_ID || undefined,
    /** Facebook Login for Business configuration of the app's "API setup with Unified login" (not a secret). */
    metaConfigId: env.HEPSON_META_CONFIG_ID || undefined,
    metaAppSecret: env.HEPSON_META_APP_SECRET || undefined,
    metaVerifyToken: env.HEPSON_META_VERIFY_TOKEN || undefined,
    metaApiVersion: env.HEPSON_META_API_VERSION || 'v26.0',
    metaGraphBaseUrl: (env.HEPSON_META_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, ''),
    metaAuthorizeUrl: env.HEPSON_META_AUTHORIZE_URL || 'https://www.facebook.com/dialog/oauth',
    /** Poll Instagram for new messages every N seconds (0 = off). A fallback for missed webhooks; webhooks stay the primary path. */
    instagramPollSeconds: int(env.HEPSON_INSTAGRAM_POLL_SECONDS, 0),
    /** Nova Poshta (P4): API base URL (override for a local mock) and how often shipped orders are tracked (0 = off). */
    novaPoshtaBaseUrl: env.HEPSON_NOVA_POSHTA_BASE_URL || 'https://api.novaposhta.ua/v2.0/json/',
    novaPoshtaPollMinutes: int(env.HEPSON_NOVA_POSHTA_POLL_MINUTES, 60),
    /** Monobank acquiring (P5): API base URL (override for a local mock) and how often open invoices, payment deadlines and reminders are checked (0 = off). */
    monobankBaseUrl: (env.HEPSON_MONOBANK_BASE_URL || 'https://api.monobank.ua').replace(/\/+$/, ''),
    paymentCheckMinutes: int(env.HEPSON_PAYMENT_CHECK_MINUTES, 5),
    /** Plan of a shop the operator has not assigned one (P7): its monthly AI-reply cap. */
    defaultPlan: planName(env.HEPSON_DEFAULT_PLAN),
    /** Where the browser is sent after the connect flow (the dashboard). */
    dashboardUrl: (env.HEPSON_DASHBOARD_URL || env.HEPSON_PUBLIC_URL || `http://${env.HEPSON_HOST ?? '127.0.0.1'}:${int(env.HEPSON_PORT, 8787)}`).replace(/\/+$/, ''),
  };
}
