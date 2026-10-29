import os from 'node:os';
import path from 'node:path';

export type Config = ReturnType<typeof loadConfig>;

const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : ['1', 'true', 'yes'].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = path.resolve(env.HEPSON_DATA_DIR ?? path.join(os.homedir(), '.hepson'));
  return {
    dataDir,
    dbFile: path.resolve(env.HEPSON_DB_FILE ?? path.join(dataDir, 'hepson.db')),
    host: env.HEPSON_HOST ?? '127.0.0.1',
    port: int(env.HEPSON_PORT, 8787),
    logLevel: env.HEPSON_LOG_LEVEL ?? 'info',
    pollIntervalMs: int(env.HEPSON_POLL_INTERVAL_MS, 20_000),
    retentionDays: int(env.HEPSON_RETENTION_DAYS, 30),
    maxMessageLength: int(env.HEPSON_MAX_MESSAGE_LENGTH, 1000),
    maxConversationsPerSync: int(env.HEPSON_MAX_CONVERSATIONS_PER_SYNC, 30),
    /** Emit message.received for pre-existing history on the first sync. Default off. */
    backfillEvents: bool(env.HEPSON_BACKFILL_EVENTS, false),
    enableDevRoutes: bool(env.HEPSON_ENABLE_DEV_ROUTES, true),
    autostart: bool(env.HEPSON_AUTOSTART, true),
    maxConcurrentBrowsers: int(env.HEPSON_MAX_BROWSERS, 3),
    browserHeadless: bool(env.HEPSON_BROWSER_HEADLESS, false),
    instagramBaseUrl: env.HEPSON_INSTAGRAM_BASE_URL ?? 'https://www.instagram.com',
    /** Dashboard users may self-register (creates a user only; no shop access). */
    allowRegistration: bool(env.HEPSON_ALLOW_REGISTRATION, true),
    sessionTtlDays: int(env.HEPSON_SESSION_TTL_DAYS, 30),
    /** Sales agent (Feature 6). The agent is inactive unless both key and model are set. Never log the key. */
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    openaiModel: env.HEPSON_OPENAI_MODEL || undefined,
    openaiBaseUrl: env.HEPSON_OPENAI_BASE_URL || undefined,
    /** Telegram notifications (Feature 8). One shared bot; each shop sets its own chat id. Never log the token. */
    telegramBotToken: env.HEPSON_TELEGRAM_BOT_TOKEN || undefined,
    telegramApiBaseUrl: env.HEPSON_TELEGRAM_API_BASE_URL || undefined,
    /** Public base URL of this API as embedded in the website chat snippet. */
    publicUrl: (env.HEPSON_PUBLIC_URL || `http://${env.HEPSON_HOST ?? '127.0.0.1'}:${int(env.HEPSON_PORT, 8787)}`).replace(/\/+$/, ''),
    /** Honour X-Forwarded-For (set only behind a reverse proxy you control; otherwise every visitor looks like the proxy). */
    trustProxy: bool(env.HEPSON_TRUST_PROXY, false),
    /** Website chat abuse limits (Feature 10). */
    webChatSessionsPerIpPerHour: int(env.HEPSON_WEBCHAT_SESSIONS_PER_IP_HOUR, 20),
    webChatMessagesPerSessionPerMinute: int(env.HEPSON_WEBCHAT_MESSAGES_PER_SESSION_MINUTE, 10),
    webChatMessagesPerIpPerMinute: int(env.HEPSON_WEBCHAT_MESSAGES_PER_IP_MINUTE, 40),
    webChatDailyMessagesPerShop: int(env.HEPSON_WEBCHAT_DAILY_MESSAGES_PER_SHOP, 2000),
    webChatSessionDays: int(env.HEPSON_WEBCHAT_SESSION_DAYS, 30),
    loginWaitMs: int(env.HEPSON_LOGIN_WAIT_MS, 10 * 60_000),
  };
}
