import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, call, type TestApp } from '../helpers';
import { ScriptedLlm, say } from '../fixtures/scripted-llm';

const PW = 'correct horse battery';
const ORIGIN = 'https://shop.example';
let a: TestApp | undefined;
afterEach(async () => {
  await a?.close();
  a?.cleanup();
  a = undefined;
});

async function login(email: string) {
  await call(a!, null, 'POST', '/v1/auth/register', { email, displayName: email, password: PW });
  return (await call(a!, null, 'POST', '/v1/auth/login', { email, password: PW })).body.token as string;
}
async function setup(over: Parameters<typeof makeApp>[0] = {}, o: { enable?: boolean; ai?: boolean } = {}) {
  a = await makeApp(over);
  const token = await login('o@example.com');
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
  const cfg = (await call(a, token, 'PUT', `/v1/shops/${shopId}/web-chat`, { enabled: o.enable !== false, allowedOrigins: [ORIGIN] })).body;
  if (o.ai !== false) await call(a, token, 'PUT', `/v1/shops/${shopId}/ai`, { enabled: true });
  return { token, shopId, key: cfg.widgetKey as string };
}
type S = Awaited<ReturnType<typeof setup>>;

type W = { origin?: string | null; visitor?: string; payload?: unknown; ip?: string };
async function web(method: 'GET' | 'POST' | 'OPTIONS', key: string, path: string, w: W = {}) {
  const headers: Record<string, string> = {};
  if (w.origin !== null) headers.origin = w.origin ?? ORIGIN;
  if (w.visitor) headers['x-hepson-visitor'] = w.visitor;
  const res = await a!.app.inject({ method, url: `/public/web-chat/${key}${path}`, headers, payload: w.payload as never, remoteAddress: w.ip });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}
const start = async (s: S, w: W = {}) => (await web('POST', s.key, '/session', { payload: {}, ...w })).body.token as string;
const say_ = async (s: S, visitor: string, text: string, ip?: string) => {
  const r = await web('POST', s.key, '/messages', { visitor, payload: { text }, ip });
  await a!.salesAgent?.whenIdle();
  return r;
};
const read = async (s: S, visitor: string, afterSeq = 0) => (await web('GET', s.key, `/messages?afterSeq=${afterSeq}`, { visitor })).body.items as Array<Record<string, any>>;

describe('web chat settings', () => {
  it('is off and empty by default; owner configures; origins are validated; manager reads, outsider 404', async () => {
    a = await makeApp();
    const token = await login('o@example.com');
    const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
    const url = `/v1/shops/${shopId}/web-chat`;
    expect((await call(a, token, 'GET', url)).body).toMatchObject({ enabled: false, widgetKey: null, allowedOrigins: [], snippet: null });

    for (const bad of ['*', 'https://*.shop.example', 'https://shop.example/', 'https://shop.example/path', 'shop.example', 'javascript:alert(1)', 'https://u:p@shop.example']) {
      expect((await call(a, token, 'PUT', url, { allowedOrigins: [bad] })).status, bad).toBe(400);
    }
    expect((await call(a, token, 'PUT', url, { cors: '*' })).status).toBe(400);

    const r = await call(a, token, 'PUT', url, { enabled: true, allowedOrigins: ['HTTPS://Shop.Example'.toLowerCase(), ORIGIN, 'http://localhost:3000'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, allowedOrigins: [ORIGIN, 'http://localhost:3000'], widgetKey: expect.stringMatching(/^hwk_/) });
    expect(r.body.snippet).toContain(`data-key="${r.body.widgetKey}"`);
    expect(r.body.snippet).toContain('/widget/web-chat.js');

    const mgr = await login('m@example.com');
    await call(a, token, 'POST', `/v1/shops/${shopId}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a, mgr, 'GET', url)).status).toBe(200);
    expect((await call(a, mgr, 'PUT', url, { enabled: false })).status).toBe(403);
    expect((await call(a, mgr, 'POST', `${url}/rotate-key`)).status).toBe(403);
    const out = await login('x@example.com');
    expect((await call(a, out, 'GET', url)).status).toBe(404);
    expect((await call(a, a.admin, 'GET', url)).status).toBe(401);
  });

  it('rotating the key kills old snippets at once', async () => {
    const s = await setup();
    expect((await web('POST', s.key, '/session', { payload: {} })).status).toBe(201);
    const rot = await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/web-chat/rotate-key`);
    expect(rot.body.widgetKey).not.toBe(s.key);
    expect((await web('POST', s.key, '/session', { payload: {} })).status).toBe(404);
    expect((await web('POST', rot.body.widgetKey, '/session', { payload: {} })).status).toBe(201);
  });
});

describe('web chat conversation', () => {
  it('visitor writes, the AI answers from tools, the shop sees a website conversation; the visitor sees a safe view', async () => {
    const llm = new ScriptedLlm([say('Вітаю! Чим можу допомогти?')]);
    const s = await setup({ llm });
    const v = await start(s);
    const sent = await say_(s, v, 'Привіт, є худі?');
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({ from: 'visitor', fromAi: false, text: 'Привіт, є худі?' });

    const items = await read(s, v);
    expect(items.map((m) => [m.from, m.fromAi, m.text])).toEqual([
      ['visitor', false, 'Привіт, є худі?'],
      ['shop', true, 'Вітаю! Чим можу допомогти?'],
    ]);
    expect(Object.keys(items[1]!).sort()).toEqual(['createdAt', 'from', 'fromAi', 'messageId', 'seq', 'text']);
    expect(await read(s, v, items[1]!.seq)).toEqual([]);

    const convs = (await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/conversations`)).body.items;
    expect(convs).toMatchObject([{ channel: 'website', customer: { channel: 'website', displayName: expect.stringContaining('Відвідувач') } }]);
    const m = a!.conversations.listMessages(s.shopId, convs[0].conversationId).items;
    expect(m[1]).toMatchObject({ senderType: 'ai', deliveryStatus: 'sent', externalId: expect.stringMatching(/^web:/) });
    expect(a!.agentRepo.listRuns(s.shopId).items).toMatchObject([{ status: 'replied' }]);
  });

  it('no AI: the message is stored, nobody answers, and a human can reply and take over', async () => {
    const llm = new ScriptedLlm([]);
    const s = await setup({ llm }, { ai: false });
    const v = await start(s, { ip: '10.0.0.1' });
    await say_(s, v, 'Є хтось?');
    expect(llm.calls).toHaveLength(0);
    const convId = (await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/conversations`)).body.items[0].conversationId as string;

    const r = await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/conversations/${convId}/messages`, { text: 'Так, я менеджер.' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ senderType: 'human', deliveryStatus: 'sent', aiPaused: true });
    expect((await read(s, v)).map((m) => [m.from, m.fromAi, m.text])).toEqual([['visitor', false, 'Є хтось?'], ['shop', false, 'Так, я менеджер.']]);
  });

  it('a paused conversation is not answered by the AI; unsent (pending) replies are invisible to the visitor', async () => {
    const llm = new ScriptedLlm([]);
    const s = await setup({ llm });
    const v = await start(s);
    await say_(s, v, 'hi'); // script is empty => model call fails => failed run, no reply
    const convId = (await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/conversations`)).body.items[0].conversationId as string;
    await call(a!, s.token, 'PUT', `/v1/shops/${s.shopId}/conversations/${convId}/ai`, { paused: true });
    a!.conversations.recordOutbound(s.shopId, convId, { senderType: 'system', text: 'draft not delivered', deliveryStatus: 'pending' });
    const calls = llm.calls.length;
    await say_(s, v, 'ще раз');
    expect(llm.calls).toHaveLength(calls);
    expect((await read(s, v)).map((m) => m.text)).toEqual(['hi', 'ще раз']);
  });

  it('validates text', async () => {
    const s = await setup({ llm: new ScriptedLlm([]) }, { ai: false });
    const v = await start(s);
    for (const payload of [{ text: '   ' }, { text: 'x'.repeat(1001) }, {}, { text: 'ok', senderType: 'ai' }, { text: 5 }]) {
      expect((await web('POST', s.key, '/messages', { visitor: v, payload })).status).toBe(400);
    }
    expect((await web('POST', s.key, '/session', { payload: { name: 'x'.repeat(61) } })).status).toBe(400);
  });
});

describe('web chat access control', () => {
  it('unknown, disabled and rotated keys answer 404; a bad Origin 403; nothing leaks which', async () => {
    const s = await setup();
    expect((await web('POST', 'hwk_doesnotexist', '/session', { payload: {} })).status).toBe(404);
    expect((await web('POST', s.key, '/session', { origin: 'https://evil.example', payload: {} })).status).toBe(403);
    expect((await web('POST', s.key, '/session', { origin: 'https://shop.example.evil.com', payload: {} })).status).toBe(403);
    expect((await web('POST', s.key, '/session', { origin: 'http://shop.example', payload: {} })).status).toBe(403);
    expect((await web('POST', s.key, '/session', { origin: null, payload: {} })).status).toBe(403);
    expect((await web('POST', s.key, '/session', { origin: ORIGIN.toUpperCase(), payload: {} })).status).toBe(201);
    await call(a!, s.token, 'PUT', `/v1/shops/${s.shopId}/web-chat`, { enabled: false });
    expect((await web('POST', s.key, '/session', { payload: {} })).status).toBe(404);
  });

  it('an empty allow-list admits nobody', async () => {
    const s = await setup();
    await call(a!, s.token, 'PUT', `/v1/shops/${s.shopId}/web-chat`, { allowedOrigins: [] });
    expect((await web('POST', s.key, '/session', { payload: {} })).status).toBe(403);
  });

  it('CORS headers only for an allowed origin; preflight follows the same rule', async () => {
    const s = await setup();
    const ok = await web('POST', s.key, '/session', { payload: {} });
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers.vary).toContain('Origin');
    const bad = await web('POST', s.key, '/session', { origin: 'https://evil.example', payload: {} });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();

    const pre = await web('OPTIONS', s.key, '/messages');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toContain('x-hepson-visitor');
    expect((await web('OPTIONS', s.key, '/messages', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await web('OPTIONS', 'hwk_nope', '/messages')).status).toBe(403);
    // Errors stay readable for the allowed page.
    expect((await web('GET', s.key, '/messages')).headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('needs a valid visitor token: missing, garbage, expired, or another shop’s token are all 401', async () => {
    const s = await setup({ llm: new ScriptedLlm([]) }, { ai: false });
    const v = await start(s);
    expect((await web('GET', s.key, '/messages')).status).toBe(401);
    expect((await web('GET', s.key, '/messages', { visitor: 'hwv_nonsense' })).status).toBe(401);
    expect((await web('GET', s.key, '/messages', { visitor: 'x'.repeat(500) })).status).toBe(401);
    expect((await web('POST', s.key, '/messages', { visitor: 'hwv_nonsense', payload: { text: 'hi' } })).status).toBe(401);

    const t2 = await login('o2@example.com');
    const shop2 = (await call(a!, t2, 'POST', '/v1/shops', { name: 'Інший', slug: 'shop-two' })).body.shopId as string;
    const key2 = (await call(a!, t2, 'PUT', `/v1/shops/${shop2}/web-chat`, { enabled: true, allowedOrigins: [ORIGIN] })).body.widgetKey as string;
    expect((await web('GET', key2, '/messages', { visitor: v })).status).toBe(401);
    expect((await web('POST', key2, '/messages', { visitor: v, payload: { text: 'hi' } })).status).toBe(401);

    expect((await web('GET', s.key, '/messages', { visitor: v })).status).toBe(200);
    a!.handle.raw.prepare("update web_chat_sessions set expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await web('GET', s.key, '/messages', { visitor: v })).status).toBe(401);
  });

  it('two visitors never see each other’s messages', async () => {
    const s = await setup({ llm: new ScriptedLlm([]) }, { ai: false });
    const v1 = await start(s);
    const v2 = await start(s);
    await say_(s, v1, 'секрет першого');
    await say_(s, v2, 'повідомлення другого');
    expect((await read(s, v1)).map((m) => m.text)).toEqual(['секрет першого']);
    expect((await read(s, v2)).map((m) => m.text)).toEqual(['повідомлення другого']);
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/conversations`)).body.total).toBe(2);
  });
});

describe('web chat abuse limits', () => {
  it('limits sessions per IP and answers 429 with Retry-After', async () => {
    const s = await setup({ webChatSessionsPerIpPerHour: 2 });
    expect((await web('POST', s.key, '/session', { payload: {}, ip: '10.0.0.5' })).status).toBe(201);
    expect((await web('POST', s.key, '/session', { payload: {}, ip: '10.0.0.5' })).status).toBe(201);
    const r = await web('POST', s.key, '/session', { payload: {}, ip: '10.0.0.5' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('RATE_LIMITED_OR_BLOCKED');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect((await web('POST', s.key, '/session', { payload: {}, ip: '10.0.0.6' })).status).toBe(201);
  });

  it('limits messages per session and per IP; a blocked message is not stored and does not wake the AI', async () => {
    const llm = new ScriptedLlm([]);
    const s = await setup({ webChatMessagesPerSessionPerMinute: 2, webChatMessagesPerIpPerMinute: 3, llm }, { ai: false });
    const v = await start(s, { ip: '10.0.0.7' });
    expect((await say_(s, v, '1', '10.0.0.7')).status).toBe(201);
    expect((await say_(s, v, '2', '10.0.0.7')).status).toBe(201);
    expect((await say_(s, v, '3', '10.0.0.7')).status).toBe(429);
    expect((await read(s, v)).map((m) => m.text)).toEqual(['1', '2']);
    const v2 = await start(s, { ip: '10.0.0.8' });
    expect((await web('POST', s.key, '/messages', { visitor: v2, payload: { text: 'a' }, ip: '10.0.0.7' })).status).toBe(201);
    expect((await web('POST', s.key, '/messages', { visitor: v2, payload: { text: 'b' }, ip: '10.0.0.7' })).status).toBe(429);
  });

  it('caps visitor messages per shop per day', async () => {
    const s = await setup({ webChatDailyMessagesPerShop: 2, llm: new ScriptedLlm([]) }, { ai: false });
    const v1 = await start(s);
    const v2 = await start(s);
    expect((await say_(s, v1, 'a')).status).toBe(201);
    expect((await say_(s, v2, 'b')).status).toBe(201);
    expect((await say_(s, v1, 'c')).status).toBe(429);
  });
});

describe('widget script', () => {
  it('is served publicly as JavaScript and never writes HTML from server text', async () => {
    a = await makeApp();
    const r = await a.app.inject({ method: 'GET', url: '/widget/web-chat.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/javascript');
    expect(r.body).toContain('attachShadow');
    expect(r.body).toContain('x-hepson-visitor');
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) expect(r.body).not.toContain(banned);
  });
});
