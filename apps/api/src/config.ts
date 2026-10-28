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
    loginWaitMs: int(env.HEPSON_LOGIN_WAIT_MS, 10 * 60_000),
  };
}
