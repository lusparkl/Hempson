import { statfs } from 'node:fs/promises';
import type { Config } from '../config';
import { errorCode, type AlertMonitor, type Probe, type ProbeResult } from './alerts';
import { EgressDeniedError, hostOf } from './egress';
import type { Mailer } from './mailer';
import { TelegramApiError, TelegramBotApi } from './telegram-bot';

const OK: ProbeResult = { ok: true };
const fail = (code: string): ProbeResult => ({ ok: false, code });
const TIMEOUT_MS = 10_000;
/** Providers that do not need checking as often as the model and the alert channel. An SMTP check is a full login, so it is rarer still. */
const PROVIDER_EVERY_MS = 60_000;
const RARE_EVERY_MS = 5 * 60_000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

type Judge = (res: Response) => ProbeResult | Promise<ProbeResult>;

async function http(f: typeof fetch, url: string, init: RequestInit, judge: Judge): Promise<ProbeResult> {
  try {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const result = await judge(res);
    await res.body?.cancel().catch(() => undefined);
    return result;
  } catch (e) {
    if (e instanceof EgressDeniedError) return fail('EGRESS_DENIED');
    return fail((e as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK');
  }
}

/** For providers checked without a credential: any answer short of a server error means the service is there. */
const answers: Judge = (res) => (res.status >= 500 ? fail(`HTTP_${res.status}`) : OK);
const reachable: Judge = (res) => (res.status < 400 ? OK : fail(`HTTP_${res.status}`));
/** Our own sites are probed over https; plain http works only against a loopback host, which is not a public site. */
const isPublicHttps = (url: string) => url.startsWith('https://') && !LOOPBACK.has(hostOf(url) ?? '');

export type ProbeDeps = {
  cfg: Config;
  ping(): void;
  mailer: Mailer | null;
  vaultReady: boolean;
  /** The egress `fetch`, with this server's own public hosts allowed. */
  egress: typeof fetch;
};

/** Public sites of this deployment to check from the outside; also the hosts the probes' egress must allow. */
export function ownUrls(cfg: Config): string[] {
  return [...new Set([`${cfg.publicUrl}/ready`, cfg.dashboardUrl, ...cfg.alertUrls])].filter(isPublicHttps);
}

/** Every dependency this server has that can be checked from here. Shop-owned tokens are not probed: each failure already reaches that shop's owner and, through it, the operator. */
export function buildProbes(d: ProbeDeps): { probes: Probe[]; notWatched: string[] } {
  const { cfg, egress } = d;
  const checkMs = cfg.alertCheckSeconds * 1000;
  const providerMs = Math.max(checkMs, PROVIDER_EVERY_MS);
  const rareMs = Math.max(checkMs, RARE_EVERY_MS);
  const probes: Probe[] = [];
  const notWatched: string[] = [];

  probes.push({
    id: 'database',
    label: 'Database',
    everyMs: checkMs,
    run: async () => {
      d.ping();
      return OK;
    },
  });
  probes.push({
    id: 'disk',
    label: 'Disk space',
    everyMs: checkMs,
    run: async () => {
      const s = await statfs(cfg.dataDir);
      const freeMb = Math.floor((s.bavail * s.bsize) / 1_048_576);
      return freeMb < cfg.alertDiskFreeMb ? fail(`FREE_${freeMb}_MB`) : OK;
    },
  });
  if (!d.vaultReady) notWatched.push('shop integrations (HEPSON_MASTER_KEY is not set, tokens cannot be stored)');

  if (cfg.openaiApiKey && cfg.openaiModel) {
    const base = (cfg.openaiBaseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const models = [cfg.openaiModel, ...(cfg.photoSearch && cfg.visionModel ? [cfg.visionModel, cfg.embeddingModel] : [])];
    [...new Set(models)].forEach((model, i) =>
      probes.push({
        id: `openai:${model}`,
        label: `OpenAI (${model})`,
        everyMs: i === 0 ? checkMs : rareMs,
        // Lists the model: free, proves the key and the model name. Running out of credit shows only on real calls, so `traffic` covers that.
        run: () =>
          http(egress, `${base}/models/${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${cfg.openaiApiKey}` } }, (res) => {
            if (res.status === 401 || res.status === 403) return fail('KEY_REJECTED');
            if (res.status === 404 && !cfg.openaiBaseUrl) return fail('MODEL_NOT_FOUND');
            return res.status >= 500 ? fail(`HTTP_${res.status}`) : OK;
          }),
      }),
    );
  } else notWatched.push('OpenAI (key or model not set)');

  const telegram = new TelegramBotApi(egress, cfg.telegramApiBaseUrl);
  probes.push({
    id: 'telegram',
    label: 'Telegram Bot API',
    everyMs: checkMs,
    run: async () => {
      try {
        await telegram.getMe(cfg.alertBotToken!);
        return OK;
      } catch (e) {
        if (e instanceof TelegramApiError) return fail(e.kind === 'auth' ? 'TOKEN_REJECTED' : e.status ? `HTTP_${e.status}` : 'NETWORK');
        return fail(errorCode(e));
      }
    },
  });

  if (cfg.metaAppId && cfg.metaAppSecret && cfg.metaVerifyToken && cfg.metaConfigId) {
    probes.push({
      id: 'meta',
      label: 'Meta Graph API (Instagram)',
      everyMs: providerMs,
      // Sent without a token, so it spends no app rate limit and exposes no secret: Graph answers 4xx when it is up.
      run: () => http(egress, `${cfg.metaGraphBaseUrl}/${cfg.metaApiVersion}/`, {}, answers),
    });
  } else notWatched.push('Meta Graph API (Instagram app not configured)');

  probes.push({
    id: 'nova_poshta',
    label: 'Nova Poshta API',
    everyMs: providerMs,
    run: () =>
      http(
        egress,
        cfg.novaPoshtaBaseUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: '', modelName: 'Common', calledMethod: 'getTimeIntervals', methodProperties: {} }),
        },
        async (res) => {
          if (res.status >= 500) return fail(`HTTP_${res.status}`);
          // NP answers its API errors with a JSON `success` field; anything else is not its API.
          const body = (await res.json().catch(() => null)) as { success?: unknown } | null;
          return typeof body?.success === 'boolean' || res.status === 429 ? OK : fail('BAD_BODY');
        },
      ),
  });
  probes.push({
    id: 'monobank',
    label: 'Monobank API',
    everyMs: providerMs,
    run: () => http(egress, `${cfg.monobankBaseUrl}/api/merchant/pubkey`, {}, answers),
  });
  probes.push({ id: 'google_sheets', label: 'Google Sheets', everyMs: rareMs, run: () => http(egress, 'https://docs.google.com/', {}, answers) });

  const verify = d.mailer?.verify?.bind(d.mailer);
  if (verify) {
    probes.push({
      id: 'smtp',
      label: 'SMTP (email)',
      everyMs: rareMs,
      run: async () => {
        await verify();
        return OK;
      },
    });
  } else notWatched.push('SMTP (not configured)');

  const own = ownUrls(cfg);
  for (const url of own)
    probes.push({ id: `url:${url}`, label: `Site ${hostOf(url)}${new URL(url).pathname.replace(/\/$/, '')}`, everyMs: checkMs, run: () => http(egress, url, {}, reachable) });
  if (!own.length) notWatched.push('public URLs (no https HEPSON_PUBLIC_URL, HEPSON_DASHBOARD_URL or HEPSON_ALERT_URLS)');

  return { probes, notWatched };
}

/** Maps real provider calls to incidents. OpenAI runs on the operator's own key, so its 401/403/429 count; elsewhere a 4xx is one shop's token or one customer. */
export function trafficReporter(cfg: Config, alerts: Pick<AlertMonitor, 'traffic'>): (host: string, status: number | null) => void {
  const providers = new Map<string, { id: string; label: string; strict: boolean }>();
  const add = (url: string, id: string, label: string, strict = false) => {
    const host = hostOf(url);
    if (host) providers.set(host, { id: `traffic:${id}`, label, strict });
  };
  add(cfg.openaiBaseUrl ?? 'https://api.openai.com', 'openai', 'OpenAI real requests', true);
  add(cfg.telegramApiBaseUrl ?? 'https://api.telegram.org', 'telegram', 'Telegram real requests');
  add(cfg.metaGraphBaseUrl, 'meta', 'Meta Graph real requests');
  add(cfg.novaPoshtaBaseUrl, 'nova_poshta', 'Nova Poshta real requests');
  add(cfg.monobankBaseUrl, 'monobank', 'Monobank real requests');
  add('https://docs.google.com', 'google_sheets', 'Google Sheets real requests');
  return (host, status) => {
    const p = providers.get(host);
    if (!p) return;
    const failed = status === null || status >= 500 || (p.strict && (status === 401 || status === 403 || status === 429));
    alerts.traffic(p.id, p.label, !failed, status === null ? 'NETWORK' : `HTTP_${status}`);
  };
}
