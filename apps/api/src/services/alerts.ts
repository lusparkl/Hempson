import type { Config } from '../config';
import { createEgress, hostOf } from './egress';
import type { Notifier } from './notifier';

export type ProbeResult = { ok: true } | { ok: false; code: string };
export type Probe = { id: string; label: string; everyMs: number; run(): Promise<ProbeResult> };
/** What the rest of the server may do with the monitor: report one thing that went wrong. */
export type AlertEvents = { event(key: string, label: string, detail: string): void };

type Logger = { warn(o: object, m?: string): void };
export type AlertDeps = {
  /** Names the process in the start message. */
  title: string;
  probes: Probe[];
  /** Things that exist in the product but are not watched on this server, with the reason. */
  notWatched?: string[];
  send(text: string): Promise<void>;
  log: Logger;
  remindMs: number;
  failAfter?: number;
  now?: () => number;
};

type State = { label: string; passive: boolean; fails: number; oks: number; firstFailAt: number; lastFailAt: number; code: string; downSince: number | null; remindAt: number };
type Bucket = { at: number; count: number; label: string };

const TICK_MS = 5000;
const OK_AFTER = 2;
const TRAFFIC_FAIL_AFTER = 3;
const TRAFFIC_STREAK_MS = 10 * 60_000;
const EVENT_WINDOW_MS = 10 * 60_000;
const MAX_EVENT_KEYS = 500;
const MAX_RECENT_ERRORS = 100;
const PROBE_LIMIT_MS = 30_000;
const SEND_RETRY_MS = 30_000;
const MAX_OUTBOX = 100;
/** Telegram refuses more than 4096 characters. */
const MAX_MESSAGE = 3800;

/** A code that can go in a message: letters, digits and a little punctuation, so a stray URL with a token cannot be pasted through whole. */
const clean = (s: string) => s.replace(/[^\p{L}\p{N} _.:/-]/gu, '').slice(0, 120) || 'UNKNOWN';
/** Short and free of provider text: an error's message can hold a URL with a token or customer data, its name and `code` cannot. */
export const errorCode = (e: unknown): string => clean(String((e as { code?: unknown } | null)?.code ?? (e instanceof Error ? e.name : 'ERROR')));

const kyivTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'medium' });
const when = (ms: number) => `${kyivTime.format(ms)} Kyiv`;
function span(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * Tells the operator (not a shop) that something is down. Three inputs: `probes` run on their own schedule, `traffic`
 * reports real provider calls, `event` reports a one-off failure. Probes and traffic are separate incidents, because a
 * model can list fine while every completion is refused for lack of credit. Text only, no provider output (D49).
 *
 * The outbox outlives a failed send, so an alert raised while Telegram is unreachable still arrives afterwards.
 */
export class AlertMonitor implements AlertEvents {
  private states = new Map<string, State>();
  private buckets = new Map<string, Bucket>();
  private due = new Map<string, number>();
  private running = new Set<string>();
  private inflight = new Set<Promise<void>>();
  private outbox: string[] = [];
  private flushing: Promise<void> | null = null;
  private retryAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;
  private failAfter: number;

  constructor(private d: AlertDeps) {
    this.now = d.now ?? Date.now;
    this.failAfter = d.failAfter ?? 2;
  }

  start(): void {
    const notWatched = this.d.notWatched?.length ? `\nNot watched: ${this.d.notWatched.join('; ')}` : '';
    this.enqueue(`ℹ️ ${this.d.title} started\nWatching: ${this.d.probes.map((p) => p.label).join(', ')}${notWatched}\nAt: ${when(this.now())}`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.whenIdle();
  }

  /** Resolves when no probe or send is in flight (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size || this.flushing) await Promise.allSettled([...this.inflight, this.flushing]);
  }

  /** One pass: reminders and event roll-ups, every probe that is due, then a send. Safe to call while a slow probe is still out. */
  async tick(): Promise<void> {
    const t = this.now();
    for (const s of this.states.values()) {
      if (s.passive || s.downSince === null || !this.d.remindMs || t < s.remindAt) continue;
      s.remindAt = t + this.d.remindMs;
      this.enqueue(`🔴 STILL DOWN: ${s.label}\nCode: ${s.code}\nFor: ${span(t - s.downSince)}`);
    }
    for (const [key, b] of this.buckets) {
      if (t - b.at < EVENT_WINDOW_MS) continue;
      this.buckets.delete(key);
      if (b.count) this.enqueue(`⚠️ REPEATED: ${b.label}\n${b.count} more in the last ${Math.round(EVENT_WINDOW_MS / 60_000)} min`);
    }
    for (const p of this.d.probes) if (!this.running.has(p.id) && t >= (this.due.get(p.id) ?? 0)) this.launch(p, t);
    await this.whenIdle();
    await this.flush();
  }

  /** The outcome of one real call to a provider. Three failures in a row open an incident; real traffic closes it. */
  traffic(id: string, label: string, ok: boolean, code = 'FAILED'): void {
    this.record(id, label, ok, clean(code), TRAFFIC_FAIL_AFTER, true);
  }

  /** The first of a kind goes out at once; repeats within the window become one count. */
  event(key: string, label: string, detail: string): void {
    const t = this.now();
    const b = this.buckets.get(key);
    if (b && t - b.at < EVENT_WINDOW_MS) {
      b.count++;
      return;
    }
    if (!b && this.buckets.size >= MAX_EVENT_KEYS) return;
    this.buckets.set(key, { at: t, count: 0, label });
    this.enqueue(`⚠️ ISSUE: ${label}\nDetail: ${clean(detail)}\nAt: ${when(t)}`);
  }

  /** What is down right now, for the operator panel (D50). */
  incidents(): Array<{ label: string; code: string; since: string }> {
    return [...this.states.values()].flatMap((s) => (s.downSince === null ? [] : [{ label: s.label, code: s.code, since: new Date(s.downSince).toISOString() }]));
  }

  private launch(p: Probe, t: number): void {
    this.running.add(p.id);
    this.due.set(p.id, t + p.everyMs);
    let limit: NodeJS.Timeout | undefined;
    const overdue = new Promise<ProbeResult>((resolve) => {
      limit = setTimeout(() => resolve({ ok: false, code: 'TIMEOUT' }), PROBE_LIMIT_MS);
      limit.unref();
    });
    const run: Promise<void> = Promise.race([p.run().catch((e: unknown): ProbeResult => ({ ok: false, code: errorCode(e) })), overdue])
      .then((r) => this.record(p.id, p.label, r.ok, r.ok ? '' : clean(r.code), this.failAfter, false))
      .finally(() => {
        clearTimeout(limit);
        this.running.delete(p.id);
        this.inflight.delete(run);
      });
    this.inflight.add(run);
  }

  private record(id: string, label: string, ok: boolean, code: string, failAfter: number, passive: boolean): void {
    const t = this.now();
    let s = this.states.get(id);
    if (!s) this.states.set(id, (s = { label, passive, fails: 0, oks: 0, firstFailAt: t, lastFailAt: t, code, downSince: null, remindAt: 0 }));
    if (ok) {
      s.fails = 0;
      if (s.downSince === null || ++s.oks < OK_AFTER) return;
      this.enqueue(`🟢 RECOVERED: ${s.label}\nWas down for: ${span(t - s.downSince)}`);
      s.downSince = null;
      s.oks = 0;
      return;
    }
    s.oks = 0;
    s.code = code;
    // A rarely used provider must not add up failures from days apart.
    if (passive && t - s.lastFailAt > TRAFFIC_STREAK_MS) s.fails = 0;
    s.lastFailAt = t;
    if (s.downSince !== null) return;
    if (s.fails++ === 0) s.firstFailAt = t;
    if (s.fails < failAfter) return;
    s.downSince = s.firstFailAt;
    s.remindAt = t + this.d.remindMs;
    this.enqueue(`🔴 DOWN: ${s.label}\nCode: ${code}\nSince: ${when(s.downSince)}`);
  }

  private enqueue(text: string): void {
    this.outbox.push(text.slice(0, MAX_MESSAGE));
    if (this.outbox.length > MAX_OUTBOX) {
      this.outbox.shift();
      this.d.log.warn({ limit: MAX_OUTBOX }, 'alert outbox full: oldest alert dropped');
    }
    void this.flush();
  }

  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.outbox.length || this.now() < this.retryAt) return Promise.resolve();
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Alerts waiting together share one Telegram message, so an outage of several things is not a burst of them. */
  private async drain(): Promise<void> {
    while (this.outbox.length) {
      let count = 0;
      let length = 0;
      for (const m of this.outbox) {
        if (count && length + m.length + 2 > MAX_MESSAGE) break;
        length += m.length + 2;
        count++;
      }
      try {
        await this.d.send(this.outbox.slice(0, count).join('\n\n'));
      } catch (e) {
        this.retryAt = this.now() + SEND_RETRY_MS;
        this.d.log.warn({ code: errorCode(e) }, 'operator alert not delivered');
        return;
      }
      this.outbox.splice(0, count);
    }
  }
}

export type RecentError = { label: string; detail: string; count: number; at: string };

/**
 * The server's latest errors for the operator panel (D50), kept whether or not Telegram alerts are configured, one entry
 * per kind, newest first. The same fixed labels and short codes as the alerts. In memory: a restart empties it.
 */
export class RecentErrors implements AlertEvents {
  private items = new Map<string, RecentError>();

  constructor(
    private inner: AlertEvents | null,
    private now: () => number = Date.now,
  ) {}

  event(key: string, label: string, detail: string): void {
    this.inner?.event(key, label, detail);
    const count = (this.items.get(key)?.count ?? 0) + 1;
    this.items.delete(key);
    this.items.set(key, { label, detail: clean(detail), count, at: new Date(this.now()).toISOString() });
    if (this.items.size > MAX_RECENT_ERRORS) this.items.delete(this.items.keys().next().value!);
  }

  list(): RecentError[] {
    return [...this.items.values()].reverse();
  }
}

/** Posts to the operator's own chat, or null when alerts are not configured. The token sits in the URL as the Bot API requires, so failures carry only the HTTP status. */
export function alertSender(cfg: Pick<Config, 'alertChatId' | 'alertBotToken' | 'telegramApiBaseUrl'>, fetchImpl?: typeof fetch): ((text: string) => Promise<void>) | null {
  const { alertChatId, alertBotToken, telegramApiBaseUrl } = cfg;
  if (!alertChatId || !alertBotToken) return null;
  const egress = createEgress({ extraHosts: telegramApiBaseUrl ? [telegramApiBaseUrl] : [], fetchImpl });
  const base = (telegramApiBaseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
  return async (text) => {
    const res = await egress(`${base}/bot${alertBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: alertChatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw Object.assign(new Error(`telegram ${res.status}`), { name: `TELEGRAM_${res.status}` });
  };
}

/** Passes through unchanged and reports each outcome by host and status only, never the URL: some URLs hold a token. `null` = no HTTP answer. */
export function observeEgress(inner: typeof fetch, onResult: (host: string, status: number | null) => void): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = hostOf(raw) ?? '';
    const pending = inner(input, init);
    pending.then(
      (res) => onResult(host, res.status),
      () => onResult(host, null),
    );
    return pending;
  }) as typeof fetch;
}

/** A shop's token being refused goes to that shop's owner as before; the operator also hears about it, once per window. */
export function withChannelIssueAlerts(inner: Notifier, alerts: AlertEvents, shopName: (shopId: string) => Promise<string | undefined>): Notifier {
  return {
    notify(n) {
      inner.notify(n);
      if (n.kind !== 'channel_issue') return;
      const report = (name: string) => alerts.event(`channel:${n.shopId}:${n.channel}`, `${n.channel} needs reconnecting for shop "${name}"`, n.issue);
      void shopName(n.shopId).then(
        (name) => report(name ?? n.shopId),
        () => report(n.shopId),
      );
    },
    whenIdle: () => inner.whenIdle(),
  };
}
