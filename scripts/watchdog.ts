import { loadConfig } from '../apps/api/src/config';
import { AlertMonitor, alertSender, type ProbeResult } from '../apps/api/src/services/alerts';
import { createEgress } from '../apps/api/src/services/egress';

/**
 * The API cannot report its own death or its server's (D49). Run this as a separate process, ideally on another machine:
 * `pnpm watchdog`. It needs only the alert chat and bot variables, and the API's public URL or HEPSON_WATCHDOG_URL.
 */
const cfg = loadConfig();
const url = process.env.HEPSON_WATCHDOG_URL || `${cfg.publicUrl}/ready`;
const seconds = Math.max(5, Number(process.env.HEPSON_WATCHDOG_SECONDS) || 15);
const send = alertSender(cfg);
if (!send) {
  console.error('Set HEPSON_ALERT_TELEGRAM_CHAT_ID and a bot token (HEPSON_ALERT_TELEGRAM_BOT_TOKEN or HEPSON_TELEGRAM_BOT_TOKEN).');
  process.exit(1);
}
const egress = createEgress({ extraHosts: [url] });

const check = async (): Promise<ProbeResult> => {
  try {
    const res = await egress(url, { signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel().catch(() => undefined);
    return res.ok ? { ok: true } : { ok: false, code: `HTTP_${res.status}` };
  } catch (e) {
    return { ok: false, code: (e as Error).name === 'TimeoutError' ? 'TIMEOUT' : (e as Error).name === 'EgressDeniedError' ? 'EGRESS_DENIED' : 'NO_CONNECTION' };
  }
};

const monitor = new AlertMonitor({
  title: 'Hepson watchdog',
  probes: [{ id: 'api', label: 'Hepson API', everyMs: seconds * 1000, run: check }],
  send,
  log: { warn: (o, m) => console.warn(m, o) },
  remindMs: cfg.alertRemindMinutes * 60_000,
});
monitor.start();
// The monitor's timer does not hold the process open by itself.
setInterval(() => undefined, 60_000);
console.log(`watchdog: checking ${new URL(url).host} every ${seconds}s`);
