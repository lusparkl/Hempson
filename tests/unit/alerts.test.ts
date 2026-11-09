import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../apps/api/src/config';
import { AlertMonitor, alertSender, errorCode, observeEgress, withChannelIssueAlerts, type ProbeResult } from '../../apps/api/src/services/alerts';
import { buildProbes, ownUrls, trafficReporter } from '../../apps/api/src/services/health-probes';

const OK: ProbeResult = { ok: true };

function setup(opts: { remindMs?: number; send?: (t: string) => Promise<void> } = {}) {
  const clock = { t: Date.UTC(2026, 10, 9, 12) };
  const sent: string[] = [];
  const result = { current: OK };
  const log = { warn: vi.fn() };
  const send = opts.send ?? (async (t: string) => void sent.push(t));
  const m = new AlertMonitor({
    title: 'Test',
    probes: [{ id: 'p', label: 'Thing', everyMs: 30_000, run: async () => result.current }],
    send,
    log,
    remindMs: opts.remindMs ?? 3600_000,
    now: () => clock.t,
  });
  const step = async (ms = 30_000) => {
    await m.tick();
    clock.t += ms;
  };
  return { m, sent, result, clock, step, log };
}

describe('AlertMonitor probes', () => {
  it('alerts once after two failures and says when it recovers after two successes', async () => {
    const s = setup();
    s.result.current = { ok: false, code: 'HTTP_503' };
    await s.step();
    expect(s.sent).toEqual([]);
    await s.step();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('🔴 DOWN: Thing');
    expect(s.sent[0]).toContain('HTTP_503');
    await s.step();
    expect(s.sent).toHaveLength(1);
    s.result.current = OK;
    await s.step();
    expect(s.sent).toHaveLength(1);
    await s.step();
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]).toContain('🟢 RECOVERED: Thing');
    expect(s.sent[1]).toContain('2 min');
  });

  it('one failed check is not an outage', async () => {
    const s = setup();
    s.result.current = { ok: false, code: 'X' };
    await s.step();
    s.result.current = OK;
    await s.step();
    s.result.current = { ok: false, code: 'X' };
    await s.step();
    expect(s.sent).toEqual([]);
  });

  it('repeats an open outage at the reminder interval, or never when it is 0', async () => {
    for (const [remindMs, count] of [
      [60_000, 2],
      [0, 1],
    ] as const) {
      const s = setup({ remindMs });
      s.result.current = { ok: false, code: 'X' };
      await s.step();
      await s.step();
      await s.step(30_000);
      await s.step(30_000);
      expect(s.sent.filter((t) => t.includes('DOWN'))).toHaveLength(count);
    }
  });

  it('a probe that throws counts as failed, with only the error name in the text', async () => {
    const sent: string[] = [];
    let t = 0;
    const m = new AlertMonitor({
      title: 'Test',
      probes: [{ id: 'p', label: 'Thing', everyMs: 1, run: () => Promise.reject(new TypeError('https://x/botSECRET:TOKEN/getMe failed')) }],
      send: async (x) => void sent.push(x),
      log: { warn: vi.fn() },
      remindMs: 0,
      now: () => (t += 10),
    });
    await m.tick();
    await m.tick();
    expect(sent.join()).toContain('TypeError');
    expect(sent.join()).not.toContain('SECRET');
  });
});

describe('AlertMonitor delivery', () => {
  it('keeps alerts through a Telegram outage and delivers them together afterwards', async () => {
    const delivered: string[] = [];
    let up = false;
    const s = setup({
      send: async (t) => {
        if (!up) throw Object.assign(new Error('no'), { name: 'TELEGRAM_502' });
        delivered.push(t);
      },
    });
    s.result.current = { ok: false, code: 'X' };
    await s.step();
    await s.step();
    s.m.event('e', 'Event', 'detail');
    await s.m.whenIdle();
    expect(delivered).toEqual([]);
    expect(s.log.warn).toHaveBeenCalled();
    up = true;
    await s.m.tick();
    expect(delivered).toEqual([]); // Still inside the 30 s pause after a failed send.
    s.clock.t += 30_000;
    await s.step();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('DOWN: Thing');
    expect(delivered[0]).toContain('ISSUE: Event');
  });
});

describe('AlertMonitor traffic', () => {
  it('opens after three failures in a row and closes on real successes', async () => {
    const s = setup();
    for (let i = 0; i < 2; i++) s.m.traffic('t', 'OpenAI real requests', false, 'HTTP_429');
    await s.m.whenIdle();
    expect(s.sent).toEqual([]);
    s.m.traffic('t', 'OpenAI real requests', false, 'HTTP_429');
    await s.m.whenIdle();
    expect(s.sent[0]).toContain('DOWN: OpenAI real requests');
    s.m.traffic('t', 'OpenAI real requests', true);
    s.m.traffic('t', 'OpenAI real requests', true);
    await s.m.whenIdle();
    expect(s.sent[1]).toContain('RECOVERED: OpenAI real requests');
  });

  it('does not add up failures that are far apart', async () => {
    const s = setup();
    for (let i = 0; i < 4; i++) {
      s.m.traffic('t', 'T', false);
      s.clock.t += 11 * 60_000;
    }
    await s.m.whenIdle();
    expect(s.sent).toEqual([]);
  });

  it('a passing probe does not close a traffic incident', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.m.traffic('t', 'Real', false);
    await s.step();
    await s.step();
    await s.step();
    expect(s.sent.filter((t) => t.includes('RECOVERED'))).toEqual([]);
  });

  it('reports only real-provider outcomes, and counts OpenAI 429 but not a shop 4xx', () => {
    const traffic = vi.fn();
    const report = trafficReporter(loadConfig({}), { traffic });
    report('api.openai.com', 429);
    report('api.monobank.ua', 403);
    report('api.telegram.org', 502);
    report('api.novaposhta.ua', null);
    report('cdn.example.com', null);
    expect(traffic.mock.calls).toEqual([
      ['traffic:openai', 'OpenAI real requests', false, 'HTTP_429'],
      ['traffic:monobank', 'Monobank real requests', true, 'HTTP_403'],
      ['traffic:telegram', 'Telegram real requests', false, 'HTTP_502'],
      ['traffic:nova_poshta', 'Nova Poshta real requests', false, 'NETWORK'],
    ]);
  });
});

describe('AlertMonitor events', () => {
  it('sends the first at once and rolls up the rest into one count', async () => {
    const s = setup();
    s.m.event('k', 'API answered 500', 'GET /x');
    s.m.event('k', 'API answered 500', 'GET /x');
    s.m.event('k', 'API answered 500', 'GET /x');
    await s.m.whenIdle();
    expect(s.sent).toHaveLength(1);
    s.clock.t += 10 * 60_000;
    s.result.current = OK;
    await s.m.tick();
    expect(s.sent[1]).toContain('REPEATED: API answered 500');
    expect(s.sent[1]).toContain('2 more');
  });

  it('strips everything that is not a code from the detail', async () => {
    const s = setup();
    s.m.event('k', 'L', 'https://x?token=abc&y=<b>');
    await s.m.whenIdle();
    expect(s.sent[0]).not.toMatch(/[?&=<>]/);
  });

  it('errorCode prefers a code and never returns the message', () => {
    expect(errorCode(Object.assign(new Error('secret text'), { code: 'EAUTH' }))).toBe('EAUTH');
    expect(errorCode(new RangeError('secret text'))).toBe('RangeError');
    expect(errorCode('secret text')).toBe('ERROR');
  });
});

describe('channel issue forwarding', () => {
  it('still tells the shop, and tells the operator by shop name', async () => {
    const inner = { notify: vi.fn(), whenIdle: vi.fn(async () => undefined) };
    const alerts = { event: vi.fn() };
    const n = withChannelIssueAlerts(inner, alerts, async () => 'Магазин');
    n.notify({ kind: 'channel_issue', shopId: 's1', channel: 'monobank', issue: 'needs_reconnect' });
    n.notify({ kind: 'plan_expired', shopId: 's1', paidUntil: '2026-11-01' });
    await new Promise((r) => setImmediate(r));
    expect(inner.notify).toHaveBeenCalledTimes(2);
    expect(alerts.event).toHaveBeenCalledOnce();
    expect(alerts.event.mock.calls[0]![1]).toContain('Магазин');
  });
});

describe('observeEgress', () => {
  it('reports host and status, and hands back the same response or failure', async () => {
    const seen: [string, number | null][] = [];
    const res = new Response('x', { status: 503 });
    const good = observeEgress((async () => res) as typeof fetch, (h, s) => seen.push([h, s]));
    expect(await good('https://api.telegram.org/botSECRET/getMe')).toBe(res);
    const bad = observeEgress((async () => Promise.reject(new TypeError('x'))) as typeof fetch, (h, s) => seen.push([h, s]));
    await expect(bad('https://api.openai.com/v1/x')).rejects.toThrow(TypeError);
    expect(seen).toEqual([
      ['api.telegram.org', 503],
      ['api.openai.com', null],
    ]);
  });
});

describe('alertSender', () => {
  it('is off without a chat or a token', () => {
    expect(alertSender({ alertChatId: undefined, alertBotToken: 't', telegramApiBaseUrl: undefined })).toBeNull();
    expect(alertSender({ alertChatId: '1', alertBotToken: undefined, telegramApiBaseUrl: undefined })).toBeNull();
  });

  it('posts plain text to the operator chat and throws on a refusal without the token', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    const send = alertSender({ alertChatId: '42', alertBotToken: 'SECRET', telegramApiBaseUrl: 'https://tg.test/' }, f as never)!;
    await send('hello');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://tg.test/botSECRET/sendMessage');
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: '42', text: 'hello' });
    expect(JSON.parse(init.body as string).parse_mode).toBeUndefined();
    const refused = alertSender({ alertChatId: '42', alertBotToken: 'SECRET', telegramApiBaseUrl: 'https://tg.test' }, (async () => new Response('', { status: 403 })) as never)!;
    const err = await refused('x').catch((e: Error) => e);
    expect((err as Error).name).toBe('TELEGRAM_403');
    expect(String((err as Error).message)).not.toContain('SECRET');
  });
});

describe('buildProbes', () => {
  const cfgOf = (env: Record<string, string> = {}) =>
    loadConfig({
      HEPSON_ALERT_TELEGRAM_CHAT_ID: '1',
      HEPSON_ALERT_TELEGRAM_BOT_TOKEN: 'T',
      HEPSON_DATA_DIR: '/tmp',
      OPENAI_API_KEY: 'k',
      HEPSON_OPENAI_MODEL: 'gpt-x',
      HEPSON_PHOTO_SEARCH: 'false',
      ...env,
    });
  const deps = (fetchImpl: unknown, env?: Record<string, string>, extra: object = {}) => ({
    cfg: cfgOf(env),
    ping: () => undefined,
    mailer: null,
    vaultReady: true,
    egress: fetchImpl as typeof fetch,
    ...extra,
  });
  const run = async (id: string, status: number, body = '{}') => {
    const { probes } = buildProbes(deps(async () => new Response(body, { status })));
    return probes.find((p) => p.id === id)!.run();
  };

  it('judges OpenAI from the status', async () => {
    expect(await run('openai:gpt-x', 200)).toEqual(OK);
    expect(await run('openai:gpt-x', 429)).toEqual(OK);
    expect(await run('openai:gpt-x', 401)).toEqual({ ok: false, code: 'KEY_REJECTED' });
    expect(await run('openai:gpt-x', 404)).toEqual({ ok: false, code: 'MODEL_NOT_FOUND' });
    expect(await run('openai:gpt-x', 503)).toEqual({ ok: false, code: 'HTTP_503' });
  });

  it('treats a tokenless provider as up on any answer short of a server error', async () => {
    expect(await run('monobank', 403)).toEqual(OK);
    expect(await run('monobank', 502)).toEqual({ ok: false, code: 'HTTP_502' });
    expect(await run('nova_poshta', 200, '{"success":false,"errors":["bad key"]}')).toEqual(OK);
    expect(await run('nova_poshta', 200, '<html>')).toEqual({ ok: false, code: 'BAD_BODY' });
  });

  it('reports a refused Telegram token and a network failure', async () => {
    expect(await run('telegram', 401)).toEqual({ ok: false, code: 'TOKEN_REJECTED' });
    const { probes } = buildProbes(deps(async () => Promise.reject(new TypeError('x'))));
    expect(await probes.find((p) => p.id === 'telegram')!.run()).toEqual({ ok: false, code: 'NETWORK' });
    expect(await probes.find((p) => p.id === 'monobank')!.run()).toEqual({ ok: false, code: 'NETWORK' });
  });

  it('fails the disk check under the limit and the database check when ping throws', async () => {
    const { probes } = buildProbes(deps(async () => new Response(), { HEPSON_ALERT_DISK_FREE_MB: '999999999999' }));
    const disk = await probes.find((p) => p.id === 'disk')!.run();
    expect(disk.ok).toBe(false);
    const broken = buildProbes(
      deps(async () => new Response(), undefined, {
        ping: () => {
          throw new Error('x');
        },
      }),
    );
    await expect(broken.probes.find((p) => p.id === 'database')!.run()).rejects.toThrow();
  });

  it('checks a smtp login, and names what it cannot watch', async () => {
    const verify = vi.fn(async () => undefined);
    const on = buildProbes(deps(async () => new Response(), undefined, { mailer: { send: async () => undefined, verify } }));
    await on.probes.find((p) => p.id === 'smtp')!.run();
    expect(verify).toHaveBeenCalledOnce();
    const off = buildProbes(deps(async () => new Response(), { OPENAI_API_KEY: '' }, { vaultReady: false }));
    const text = off.notWatched.join();
    for (const name of ['OpenAI', 'SMTP', 'Meta', 'HEPSON_MASTER_KEY', 'public URLs']) expect(text).toContain(name);
  });

  it('watches https public addresses only', () => {
    expect(ownUrls(cfgOf())).toEqual([]);
    expect(
      ownUrls(cfgOf({ HEPSON_PUBLIC_URL: 'https://api.shop.test', HEPSON_DASHBOARD_URL: 'https://app.shop.test', HEPSON_ALERT_URLS: 'https://shop.test, http://plain.test' })),
    ).toEqual(['https://api.shop.test/ready', 'https://app.shop.test', 'https://shop.test']);
  });

  it('spaces out the checks that cost something at the provider', () => {
    const { probes } = buildProbes(
      deps(async () => new Response(), { HEPSON_META_APP_ID: 'a', HEPSON_META_APP_SECRET: 'b', HEPSON_META_VERIFY_TOKEN: 'c', HEPSON_META_CONFIG_ID: 'd' }),
    );
    const every = Object.fromEntries(probes.map((p) => [p.id, p.everyMs]));
    expect(every).toMatchObject({ database: 30_000, telegram: 30_000, meta: 60_000, monobank: 60_000, google_sheets: 300_000 });
  });
});
