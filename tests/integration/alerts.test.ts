import { afterEach, describe, expect, it } from 'vitest';
import { call, customerWrites, makeApp, type TestApp } from '../helpers';

let a: TestApp | undefined;
afterEach(async () => {
  await a?.close();
  a?.cleanup();
  a = undefined;
});

/** Every outbound call of the app lands here; Telegram posts are the alerts. */
function fakeNet(answer: (url: string) => number = () => 200) {
  const alerts: string[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/sendMessage')) alerts.push(JSON.parse(init!.body as string).text);
    if (url.includes('/getMe')) return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'b' } }), { status: 200 });
    return new Response('{}', { status: answer(url) });
  }) as typeof fetch;
  return { alerts, urls, fetchImpl };
}
const on = { alertChatId: '777', alertBotToken: 'ALERT:TOKEN', telegramApiBaseUrl: undefined };

describe('operator alerts in the running server', () => {
  it('stays off and sends nothing without a chat', async () => {
    const net = fakeNet();
    a = await makeApp({ alertChatId: undefined, alertBotToken: undefined, fetchImpl: net.fetchImpl });
    expect(a.alerts).toBeNull();
    expect(net.urls).toEqual([]);
  });

  it('announces the start with what it watches and what it cannot', async () => {
    const net = fakeNet();
    a = await makeApp({ ...on, smtp: null, mailer: null, openaiApiKey: undefined, fetchImpl: net.fetchImpl });
    await a.alerts!.whenIdle();
    expect(net.alerts[0]).toContain('Hepson API started');
    expect(net.alerts[0]).toContain('Database');
    expect(net.alerts[0]).toContain('OpenAI (key or model not set)');
    expect(net.urls.some((u) => u.includes('bot') && u.includes('/getMe'))).toBe(true);
  });

  it('reports a provider that goes down on the second check', async () => {
    const net = fakeNet((u) => (u.includes('monobank') ? 503 : 200));
    a = await makeApp({ ...on, alertCheckSeconds: 5, fetchImpl: net.fetchImpl });
    await a.alerts!.tick();
    await a.alerts!.whenIdle();
    expect(net.alerts.join()).not.toContain('DOWN: Monobank');
    // Second check of the provider: its schedule says 60 s, so move the monitor's due time rather than wait.
    (a.alerts as unknown as { due: Map<string, number> }).due.clear();
    await a.alerts!.tick();
    expect(net.alerts.join()).toContain('DOWN: Monobank API');
    expect(net.alerts.join()).toContain('HTTP_503');
  });

  it('tells the operator about an unhandled 500, without the error text', async () => {
    const net = fakeNet();
    a = await makeApp({ ...on, fetchImpl: net.fetchImpl });
    a.app.get('/v1/boom/:id', async () => {
      throw new RangeError('customer +380501234567 secret');
    });
    const res = await a.app.inject({ method: 'GET', url: '/v1/boom/abc' });
    expect(res.statusCode).toBe(500);
    await a.alerts!.whenIdle();
    const text = net.alerts.join();
    expect(text).toContain('API answered 500');
    expect(text).toContain('GET /v1/boom/:id RangeError');
    expect(text).not.toContain('380501234567');
    expect(text).not.toContain('abc');
  });

  it('counts real provider calls through the shared egress', async () => {
    const net = fakeNet((u) => (u.includes('chat/completions') ? 429 : 200));
    a = await makeApp({ ...on, openaiApiKey: 'k', openaiModel: 'gpt-x', fetchImpl: net.fetchImpl });
    await call(a, null, 'POST', '/v1/auth/register', { email: 'o@example.com', displayName: 'O', password: 'correct horse battery' });
    const token = (await call(a, null, 'POST', '/v1/auth/login', { email: 'o@example.com', password: 'correct horse battery' })).body.token as string;
    const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
    await call(a, token, 'PUT', `/v1/shops/${shopId}/ai`, { enabled: true });
    // The model client tries three times, so one customer message is three real failures.
    await customerWrites(a, shopId, 'thread', 'Привіт');
    await a.alerts!.whenIdle();
    expect(net.urls.filter((u) => u.includes('chat/completions'))).toHaveLength(3);
    expect(net.alerts.join()).toContain('DOWN: OpenAI real requests');
    expect(net.alerts.join()).toContain('HTTP_429');
    expect(net.alerts.join()).not.toContain('ALERT:TOKEN');
  });
});
