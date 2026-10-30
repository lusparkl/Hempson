import { createHmac, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSTAGRAM_CHANNEL, Keyring } from '@hepson/database';
import { loadConfig } from '../../apps/api/src/config';
import { call, makeApp, type TestApp } from '../helpers';
import { ScriptedLlm, say, type Entry, type LlmStep } from '../fixtures/scripted-llm';

// Meta payloads and responses below are written from Meta's public documentation, not captured from a live account.
const PW = 'correct horse battery';
const IG = '17841400000000001';
const CUSTOMER = '5551230001';
const APP_SECRET = 'app-secret-for-tests';
const VERIFY = 'verify-me';
const TOKEN_LONG = 'EAAB-system-user-token-0001';

let a: TestApp | undefined;
afterEach(async () => {
  await a?.close();
  a?.cleanup();
  a = undefined;
});

type Graph = {
  calls: Array<{ method: string; url: string; auth: string | null; body: string | null }>;
  send: () => Response;
  accounts: () => Response;
  exchange: () => Response;
  conversations: () => Response | Promise<Response>;
  subscribe: () => Response;
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function fakeMeta(): Graph & { fetchImpl: typeof fetch } {
  let n = 0;
  const g: Graph = {
    calls: [],
    send: () => json({ recipient_id: CUSTOMER, message_id: `mid.out${++n}` }),
    accounts: () => json({ data: [{ id: IG, username: 'shop_ig' }] }),
    exchange: () => json({ access_token: TOKEN_LONG, token_type: 'bearer' }),
    conversations: () => json({ data: [] }),
    subscribe: () => json({ success: true }),
  };
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    g.calls.push({ method: init?.method ?? 'GET', url, auth: h.get('authorization'), body: init?.body ? String(init.body) : null });
    const u = new URL(url);
    if (u.pathname.endsWith('/oauth/access_token')) return g.exchange();
    if (u.pathname.endsWith('/me/assigned_instagram_accounts')) return g.accounts();
    if (u.pathname.endsWith('/conversations')) return g.conversations();
    if (u.pathname.endsWith('/subscribed_apps')) return init?.method === 'POST' ? g.subscribe() : json({ success: true });
    if (u.pathname.endsWith('/messages')) return g.send();
    return json({ name: 'Іра', username: 'ira_k' }); // profile lookup
  }) as typeof fetch;
  return Object.assign(g, { fetchImpl });
}

const cfgOver = { publicUrl: 'https://hepson.example', dashboardUrl: 'https://dash.example', metaAppId: 'app-1', metaConfigId: 'cfg-1', metaAppSecret: APP_SECRET, metaVerifyToken: VERIFY };
const notifier = () => ({ notify: vi.fn(), whenIdle: async () => {} });

async function login(email: string) {
  await call(a!, null, 'POST', '/v1/auth/register', { email, displayName: email, password: PW });
  return (await call(a!, null, 'POST', '/v1/auth/login', { email, password: PW })).body.token as string;
}

async function setup(o: { script?: Entry[]; ai?: boolean; notif?: ReturnType<typeof notifier>; extra?: Parameters<typeof makeApp>[0] } = {}) {
  const meta = fakeMeta();
  const llm = new ScriptedLlm(o.script ?? []);
  a = await makeApp({ ...cfgOver, keyring: new Keyring(1, randomBytes(32)), fetchImpl: meta.fetchImpl, llm, notifier: o.notif, ...o.extra });
  const token = await login('o@example.com');
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
  if (o.ai !== false) await call(a, token, 'PUT', `/v1/shops/${shopId}/ai`, { enabled: true });
  return { meta, llm, token, shopId };
}
type S = Awaited<ReturnType<typeof setup>>;

/** Runs the owner connect flow against the fake Meta; returns the callback response. */
async function connect(s: S, who = s.token) {
  const start = await call(a!, who, 'POST', `/v1/shops/${s.shopId}/instagram/connect`);
  const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
  const res = await a!.app.inject({ method: 'GET', url: `/public/instagram/callback?code=AQD-code&state=${encodeURIComponent(state)}` });
  return { start, state, res };
}
const connected = async (s: S) => {
  const r = await connect(s);
  expect(r.res.headers.location).toBe('https://dash.example/?instagram=connected');
};

const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
async function webhook(payload: unknown, o: { sig?: string | null; raw?: string } = {}) {
  const raw = o.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.sig !== null) headers['x-hub-signature-256'] = o.sig ?? sign(raw);
  const res = await a!.app.inject({ method: 'POST', url: '/webhooks/instagram', headers, payload: raw });
  await a!.ig.whenIdle();
  await a!.salesAgent?.whenIdle();
  return res;
}
const inbound = (mid: string, text: string, over: { igId?: string; sender?: string; ts?: number } = {}) => ({
  object: 'instagram',
  entry: [{ id: over.igId ?? IG, time: Date.now(), messaging: [{ sender: { id: over.sender ?? CUSTOMER }, recipient: { id: over.igId ?? IG }, timestamp: over.ts ?? Date.now(), message: { mid, text } }] }],
});
const echo = (mid: string, text: string) => ({
  object: 'instagram',
  entry: [{ id: IG, time: Date.now(), messaging: [{ sender: { id: IG }, recipient: { id: CUSTOMER }, timestamp: Date.now(), message: { mid, text, is_echo: true } }] }],
});

/** The `changes[]` envelope of Meta's webhook fields (also what the dashboard test button sends). */
const asChange = (p: ReturnType<typeof inbound>) => ({ object: 'instagram', entry: [{ id: p.entry[0]!.id, time: p.entry[0]!.time, changes: [{ field: 'messages', value: p.entry[0]!.messaging[0] }] }] });

const conv = (s: S) => a!.conversations.findConversationByExternal(s.shopId, INSTAGRAM_CHANNEL, CUSTOMER);
const msgs = (s: S) => a!.conversations.listMessages(s.shopId, conv(s)!.conversation.id, { limit: 100 }).items;
const sends = (s: S) => s.meta.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'));
const runs = (s: S) => a!.agentRepo.listRuns(s.shopId, { limit: 50 }).items;

describe('connect flow', () => {
  it('owner connects; token is stored encrypted and never returned; state is single use', async () => {
    const s = await setup();
    const { start, state, res } = await connect(s);
    const url = new URL(start.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('app-1');
    expect(url.searchParams.get('config_id')).toBe('cfg-1');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('override_default_response_type')).toBe('true');
    expect(url.searchParams.has('scope')).toBe(false); // the configuration defines the permissions
    expect(url.searchParams.get('redirect_uri')).toBe('https://hepson.example/public/instagram/callback');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://dash.example/?instagram=connected');

    // the code is exchanged on the Graph host with the Meta app's id and secret (server side)
    const exchange = s.meta.calls.find((c) => c.url.includes('/oauth/access_token'))!;
    expect(exchange.method).toBe('GET');
    expect(exchange.url.startsWith('https://graph.facebook.com/v26.0/oauth/access_token?')).toBe(true);
    expect(Object.fromEntries(new URL(exchange.url).searchParams)).toEqual({ client_id: 'app-1', client_secret: APP_SECRET, redirect_uri: 'https://hepson.example/public/instagram/callback', code: 'AQD-code' });
    const accounts = s.meta.calls.find((c) => c.url.includes('/me/assigned_instagram_accounts'))!;
    expect(accounts.auth).toBe(`Bearer ${TOKEN_LONG}`);

    const status = await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/instagram`);
    expect(status.body).toMatchObject({ available: true, status: 'connected', username: 'shop_ig' });
    expect(JSON.stringify(status.body)).not.toContain('IGAA');
    expect(a!.vault.get(s.shopId, 'instagram')).toMatchObject({ status: 'active' });
    expect(JSON.stringify(a!.handle.raw.prepare('select * from shop_credentials').all())).not.toContain(TOKEN_LONG);
    expect(s.meta.calls.some((c) => c.method === 'POST' && c.url.includes('/subscribed_apps?subscribed_fields=messages'))).toBe(true);

    // replaying the same state gets nothing
    const again = await a!.app.inject({ method: 'GET', url: `/public/instagram/callback?code=x&state=${state}` });
    expect(again.headers.location).toBe('https://dash.example/?instagram=error');
  });

  it.each([503, 200])('does not connect when webhook subscription fails with HTTP %i', async (status) => {
    const s = await setup();
    s.meta.subscribe = () => (status === 200 ? json({ success: false }) : json({ error: { code: 2 } }, status));
    const r = await connect(s);
    expect(r.res.headers.location).toBe('https://dash.example/?instagram=error');
    expect(a!.ig.status(s.shopId).status).toBe('not_connected');
    expect(a!.vault.get(s.shopId, 'instagram')).toBeUndefined();

    s.meta.subscribe = () => json({ success: true });
    await connected(s);
    expect(a!.ig.status(s.shopId)).toMatchObject({ status: 'connected', lastError: null });
  });

  it('preserves an existing connection when replacement webhook subscription fails', async () => {
    const s = await setup();
    await connected(s);
    const before = a!.igRepo.getChannel(s.shopId);
    s.meta.exchange = () => json({ access_token: 'replacement-token' });
    s.meta.accounts = () => json({ data: [{ id: '17841400000000002', username: 'another_shop' }] });
    s.meta.subscribe = () => json({ error: { code: 200 } }, 403);
    const r = await connect(s);
    expect(r.res.headers.location).toBe('https://dash.example/?instagram=error');
    expect(a!.igRepo.getChannel(s.shopId)).toEqual(before);
    expect(await a!.vault.withSecret(s.shopId, 'instagram', async (token) => token === TOKEN_LONG)).toBe(true);
  });

  it('rolls back channel and token changes together when saving a replacement fails', async () => {
    const s = await setup();
    await connected(s);
    const before = a!.igRepo.getChannel(s.shopId);
    s.meta.exchange = () => json({ access_token: 'replacement-token' });
    s.meta.accounts = () => json({ data: [{ id: '17841400000000002', username: 'another_shop' }] });
    const save = a!.vault.save.bind(a!.vault);
    const failingSave = vi.spyOn(a!.vault, 'save').mockImplementationOnce((...args) => {
      save(...args);
      throw new Error('simulated storage failure');
    });
    const r = await connect(s);
    failingSave.mockRestore();
    expect(r.res.headers.location).toBe('https://dash.example/?instagram=error');
    expect(a!.igRepo.getChannel(s.shopId)).toEqual(before);
    expect(await a!.vault.withSecret(s.shopId, 'instagram', async (token) => token === TOKEN_LONG)).toBe(true);
  });

  it('only owners connect; outsiders get 404; unknown or expired state is refused; denial redirects', async () => {
    const s = await setup();
    const mgr = await login('m@example.com');
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a!, mgr, 'POST', `/v1/shops/${s.shopId}/instagram/connect`)).status).toBe(403);
    expect((await call(a!, mgr, 'GET', `/v1/shops/${s.shopId}/instagram`)).status).toBe(200);
    expect((await call(a!, mgr, 'DELETE', `/v1/shops/${s.shopId}/instagram`)).status).toBe(403);
    const out = await login('x@example.com');
    expect((await call(a!, out, 'POST', `/v1/shops/${s.shopId}/instagram/connect`)).status).toBe(404);
    expect((await call(a!, null, 'POST', `/v1/shops/${s.shopId}/instagram/connect`)).status).toBe(401);

    const bad = await a!.app.inject({ method: 'GET', url: '/public/instagram/callback?code=x&state=forged' });
    expect(bad.headers.location).toBe('https://dash.example/?instagram=error');
    const denied = await a!.app.inject({ method: 'GET', url: '/public/instagram/callback?error=access_denied&state=x' });
    expect(denied.headers.location).toBe('https://dash.example/?instagram=denied');
    expect(s.meta.calls.length).toBe(0);
    expect(a!.ig.status(s.shopId).status).toBe('not_connected');
  });

  it('one Instagram account cannot be linked to two shops', async () => {
    const s = await setup();
    await connected(s);
    const other = await login('p@example.com');
    const shop2 = (await call(a!, other, 'POST', '/v1/shops', { name: 'Інший', slug: 'shop-two' })).body.shopId as string;
    const start = await call(a!, other, 'POST', `/v1/shops/${shop2}/instagram/connect`);
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    const res = await a!.app.inject({ method: 'GET', url: `/public/instagram/callback?code=c&state=${state}` });
    expect(res.headers.location).toBe('https://dash.example/?instagram=taken');
    expect(a!.vault.get(shop2, 'instagram')).toBeUndefined();
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/instagram`)).body.status).toBe('connected');
  });

  it('is disabled, not broken, without Meta settings or a master key', async () => {
    a = await makeApp({ keyring: null, fetchImpl: fakeMeta().fetchImpl });
    const token = await login('o@example.com');
    const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'M', slug: 'shop-m' })).body.shopId as string;
    expect((await call(a, token, 'GET', `/v1/shops/${shopId}/instagram`)).body).toMatchObject({ available: false, status: 'not_connected' });
    const r = await call(a, token, 'POST', `/v1/shops/${shopId}/instagram/connect`);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('NOT_CONFIGURED');
    expect((await call(a, null, 'GET', '/webhooks/instagram?hub.mode=subscribe')).status).toBe(404);
    expect((await a.app.inject({ method: 'POST', url: '/webhooks/instagram', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(404);
  });

  it('disconnect unsubscribes, deletes the token and stops ingestion', async () => {
    const s = await setup({ script: [] });
    await connected(s);
    expect((await call(a!, s.token, 'DELETE', `/v1/shops/${s.shopId}/instagram`)).status).toBe(200);
    expect(s.meta.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/subscribed_apps'))).toBe(true);
    expect(a!.vault.get(s.shopId, 'instagram')).toBeUndefined();
    expect(a!.ig.status(s.shopId).status).toBe('not_connected');
    expect((await webhook(inbound('m1', 'Привіт'))).statusCode).toBe(200);
    expect(conv(s)).toBeUndefined();
  });
});

describe('webhook', () => {
  it('answers the Meta handshake only for the right verify token', async () => {
    await setup();
    const ok = await a!.app.inject({ method: 'GET', url: `/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    expect((await a!.app.inject({ method: 'GET', url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' })).statusCode).toBe(403);
    expect((await a!.app.inject({ method: 'GET', url: `/webhooks/instagram?hub.mode=other&hub.verify_token=${VERIFY}&hub.challenge=1` })).statusCode).toBe(403);
    expect((await a!.app.inject({ method: 'GET', url: '/webhooks/instagram' })).statusCode).toBe(403);
  });

  it('rejects a missing, malformed or wrong signature and stores nothing', async () => {
    const s = await setup({ script: [say('x')] });
    await connected(s);
    const p = inbound('m1', 'Привіт');
    const raw = JSON.stringify(p);
    for (const sig of [null, 'sha256=', 'sha256=zz', sign(raw, 'other-secret'), sign(raw).replace('sha256=', 'sha1='), sign(raw + ' ')]) {
      const r = await webhook(p, { sig, raw });
      expect(r.statusCode, String(sig)).toBe(401);
    }
    expect(conv(s)).toBeUndefined();
    expect(runs(s)).toHaveLength(0);
    expect(sends(s)).toHaveLength(0);
  });

  it('a valid signature with a non-JSON body is a 400 and stores nothing', async () => {
    const s = await setup();
    await connected(s);
    const raw = '{not json';
    expect((await webhook(null, { raw })).statusCode).toBe(400);
    expect(conv(s)).toBeUndefined();
  });

  it('one signed message gives exactly one agent run and one reply through the Send API; a replay changes nothing', async () => {
    const s = await setup({ script: [say('Вітаю! Чим допомогти?')] });
    await connected(s);
    const p = inbound('mid.in1', 'Привіт, є худі?');
    expect((await webhook(p)).statusCode).toBe(200);

    const c = conv(s)!;
    expect(c.conversation.channel).toBe(INSTAGRAM_CHANNEL);
    expect(c.customer.externalId).toBe(CUSTOMER);
    expect(runs(s)).toHaveLength(1);
    expect(runs(s)[0]).toMatchObject({ status: 'replied' });
    expect(sends(s)).toHaveLength(1);
    const call0 = sends(s)[0]!;
    expect(call0.url).toBe(`https://graph.facebook.com/v26.0/${IG}/messages`);
    expect(call0.auth).toBe(`Bearer ${TOKEN_LONG}`);
    expect(JSON.parse(call0.body!)).toEqual({ recipient: { id: CUSTOMER }, message: { text: 'Вітаю! Чим допомогти?' } });
    expect(msgs(s).map((m) => [m.direction, m.senderType, m.deliveryStatus, m.externalId])).toEqual([
      ['incoming', 'customer', 'received', 'mid.in1'],
      ['outgoing', 'ai', 'sent', 'mid.out1'],
    ]);
    // customer name and username are fetched after the ack
    expect(conv(s)!.customer).toMatchObject({ displayName: 'Іра', handle: 'ira_k' });

    // Meta retries / replays the same delivery
    expect((await webhook(p)).statusCode).toBe(200);
    expect((await webhook(p)).statusCode).toBe(200);
    expect(runs(s)).toHaveLength(1);
    expect(sends(s)).toHaveLength(1);
    expect(msgs(s)).toHaveLength(2);
  });

  it('the `changes[]` envelope is ingested like `messaging[]`, and the same message in both is stored once', async () => {
    const s = await setup({ script: [say('Вітаю!')] });
    await connected(s);
    const p = inbound('mid.in1', 'Привіт');
    expect((await webhook(asChange(p))).statusCode).toBe(200);
    expect(msgs(s).filter((m) => m.direction === 'incoming')).toHaveLength(1);
    expect(runs(s)).toHaveLength(1);
    await webhook(p);
    expect(msgs(s).filter((m) => m.direction === 'incoming')).toHaveLength(1);
    expect(runs(s)).toHaveLength(1);
  });

  it('events for unknown accounts or without a message id are acknowledged and dropped', async () => {
    const s = await setup({ script: [] });
    await connected(s);
    expect((await webhook(inbound('m9', 'Hi', { igId: '999' }))).statusCode).toBe(200);
    expect((await webhook({ object: 'page', entry: [] })).statusCode).toBe(200);
    expect((await webhook({ object: 'instagram', entry: [{ id: IG, messaging: [{ sender: { id: CUSTOMER }, recipient: { id: IG }, timestamp: 1, read: { mid: 'x' } }] }] })).statusCode).toBe(200);
    expect(conv(s)).toBeUndefined();
  });

  it('attachment-only messages are stored with kinds and wait for a person when the model has nothing to say', async () => {
    const s = await setup({ script: [say('Бачу фото, уточніть, будь ласка, що саме цікавить?')] });
    await connected(s);
    await webhook({ object: 'instagram', entry: [{ id: IG, messaging: [{ sender: { id: CUSTOMER }, recipient: { id: IG }, timestamp: Date.now(), message: { mid: 'mid.img', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/x.jpg' } }, { type: 'story_mention' }] } }] }] });
    const first = msgs(s)[0]!;
    expect(first.text).toBeNull();
    expect(first.attachments).toEqual([{ kind: 'image' }, { kind: 'other' }]); // provider URLs are not stored
  });

  it('timestamps in the future are clamped to the receive time', async () => {
    const s = await setup({ script: [say('ok')] });
    await connected(s);
    await webhook(inbound('mid.f', 'hi', { ts: Date.now() + 3 * 86_400_000 }));
    expect(Date.parse(msgs(s)[0]!.occurredAt)).toBeLessThanOrEqual(Date.now());
  });
});

describe('echoes', () => {
  it('the echo of our own reply is adopted, not stored twice, and never triggers the agent', async () => {
    const s = await setup({ script: [say('Привіт!')] });
    await connected(s);
    await webhook(inbound('mid.in1', 'Привіт'));
    expect(msgs(s)).toHaveLength(2);
    await webhook(echo('mid.out1', 'Привіт!'));
    expect(msgs(s)).toHaveLength(2);
    expect(runs(s)).toHaveLength(1);
    expect(sends(s)).toHaveLength(1);
  });

  it('an echo that arrives before the send response is adopted and the late response does not break the row', async () => {
    const s = await setup({ script: [say('Привіт!')] });
    await connected(s);
    s.meta.send = () => {
      // Meta delivers the echo webhook while our send call is still open
      const c = conv(s)!;
      a!.conversations.adoptPendingOutbound(s.shopId, c.conversation.id, 'Привіт!', 'mid.out1', 'sent', 'ai');
      return json({ recipient_id: CUSTOMER, message_id: 'mid.out1' });
    };
    await webhook(inbound('mid.in1', 'Привіт'));
    expect(msgs(s).map((m) => [m.senderType, m.deliveryStatus, m.externalId])).toEqual([
      ['customer', 'received', 'mid.in1'],
      ['ai', 'sent', 'mid.out1'],
    ]);
    expect(runs(s)[0]).toMatchObject({ status: 'replied' });
  });

  it('a reply typed in the Instagram app is stored as a human message and does not trigger the AI (D16 still manual)', async () => {
    const s = await setup({ script: [say('Привіт!')] });
    await connected(s);
    await webhook(inbound('mid.in1', 'Привіт'));
    await webhook(echo('mid.person', 'Це людина пише з додатку'));
    const m = msgs(s);
    expect(m.map((x) => [x.senderType, x.deliveryStatus])).toEqual([
      ['customer', 'received'],
      ['ai', 'sent'],
      ['human', 'sent'],
    ]);
    expect(runs(s)).toHaveLength(1);
    expect(conv(s)!.conversation.aiPaused).toBe(false);
  });
});

describe('sending rules', () => {
  it('a closed 24-hour window sends nothing, escalates and notifies', async () => {
    const notif = notifier();
    const s = await setup({
      notif,
      script: [
        (): LlmStep => {
          // the customer's last message falls out of the window while the model is still working
          a!.handle.raw.prepare("update shop_messages set occurred_at = ? where direction = 'incoming'").run(new Date(Date.now() - 25 * 3_600_000).toISOString());
          return say('Відповідь, що запізнилась');
        },
      ],
    });
    await connected(s);
    await webhook(inbound('mid.in1', 'Привіт'));
    expect(sends(s)).toHaveLength(0);
    expect(runs(s)[0]).toMatchObject({ status: 'failed', detail: 'OUTSIDE_MESSAGING_WINDOW' });
    expect(msgs(s).at(-1)).toMatchObject({ senderType: 'ai', deliveryStatus: 'failed', deliveryError: 'OUTSIDE_MESSAGING_WINDOW' });
    expect(a!.agentRepo.openEscalation(s.shopId, conv(s)!.conversation.id)).toBeTruthy();
    expect(notif.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'escalation', shopId: s.shopId }));
  });

  it('a human reply outside the window is refused before anything is recorded or paused', async () => {
    const s = await setup({ script: [say('Привіт!')] });
    await connected(s);
    await webhook(inbound('mid.in1', 'Привіт'));
    a!.handle.raw.prepare("update shop_messages set occurred_at = ? where direction = 'incoming'").run(new Date(Date.now() - 30 * 3_600_000).toISOString());
    const id = conv(s)!.conversation.id;
    const before = sends(s).length;
    const r = await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/conversations/${id}/messages`, { text: 'Добрий день' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('OUTSIDE_MESSAGING_WINDOW');
    expect(sends(s).length).toBe(before);
    expect(msgs(s)).toHaveLength(2);
    expect(conv(s)!.conversation.aiPaused).toBe(false);
  });

  it('a human reply inside the window goes through the Send API and pauses the AI', async () => {
    const s = await setup({ script: [say('Привіт!')] });
    await connected(s);
    await webhook(inbound('mid.in1', 'Привіт'));
    const id = conv(s)!.conversation.id;
    const r = await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/conversations/${id}/messages`, { text: 'Менеджер на зв’язку' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ deliveryStatus: 'sent', aiPaused: true });
    expect(sends(s)).toHaveLength(2);
    expect(JSON.parse(sends(s)[1]!.body!).message.text).toBe('Менеджер на зв’язку');
    expect(msgs(s).at(-1)).toMatchObject({ senderType: 'human', deliveryStatus: 'sent', externalId: 'mid.out2' });
  });

  it('an ambiguous outcome is uncertain and is never retried', async () => {
    const s = await setup({ script: [say('Привіт!')] });
    await connected(s);
    s.meta.send = () => new Response('upstream error', { status: 502 });
    await webhook(inbound('mid.in1', 'Привіт'));
    expect(sends(s)).toHaveLength(1);
    expect(runs(s)[0]).toMatchObject({ status: 'send_uncertain' });
    expect(msgs(s).at(-1)).toMatchObject({ deliveryStatus: 'uncertain' });
    await a!.ig.whenIdle();
    expect(sends(s)).toHaveLength(1);
  });

  it('a network failure after sending is uncertain too', async () => {
    const s = await setup({ script: [say('Привіт!')] });
    await connected(s);
    s.meta.send = () => {
      throw new TypeError('socket hang up');
    };
    await webhook(inbound('mid.in1', 'Привіт'));
    expect(sends(s)).toHaveLength(1);
    expect(msgs(s).at(-1)).toMatchObject({ deliveryStatus: 'uncertain' });
  });

  it('a clear Meta rejection is failed with a code only', async () => {
    const s = await setup({ script: [say('Привіт!')] });
    await connected(s);
    s.meta.send = () => json({ error: { message: 'Some provider text with PII', type: 'OAuthException', code: 100, error_subcode: 33 } }, 400);
    await webhook(inbound('mid.in1', 'Привіт'));
    expect(runs(s)[0]).toMatchObject({ status: 'failed', detail: 'META_100' });
    expect(msgs(s).at(-1)).toMatchObject({ deliveryStatus: 'failed', deliveryError: 'META_100' });
    expect(JSON.stringify(runs(s))).not.toContain('PII');
  });

  it('a window rejection from Meta itself maps to OUTSIDE_MESSAGING_WINDOW', async () => {
    const s = await setup({ script: [say('Привіт!')] });
    await connected(s);
    s.meta.send = () => json({ error: { message: 'x', code: 10, error_subcode: 2534022 } }, 400);
    await webhook(inbound('mid.in1', 'Привіт'));
    expect(msgs(s).at(-1)).toMatchObject({ deliveryStatus: 'failed', deliveryError: 'OUTSIDE_MESSAGING_WINDOW' });
  });
});

describe('token lifecycle', () => {
  it('a revoked token stops sending, flags reconnect, notifies once and is not retried', async () => {
    const notif = notifier();
    const s = await setup({ notif, script: [say('Привіт!'), say('Знову привіт')] });
    await connected(s);
    s.meta.send = () => json({ error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } }, 401);
    await webhook(inbound('mid.in1', 'Привіт'));
    expect(sends(s)).toHaveLength(1);
    expect(runs(s)[0]).toMatchObject({ status: 'failed', detail: 'TOKEN_REJECTED' });
    expect(a!.ig.status(s.shopId)).toMatchObject({ status: 'needs_reconnect', lastError: 'TOKEN_REJECTED' });
    expect(a!.vault.get(s.shopId, 'instagram')).toMatchObject({ status: 'needs_reconnect' });
    expect(notif.notify).toHaveBeenCalledWith({ kind: 'channel_issue', shopId: s.shopId, channel: 'instagram', issue: 'needs_reconnect' });

    // the next customer message is still stored, but nothing is sent to Meta with the dead token
    await webhook(inbound('mid.in2', 'Є хто?'));
    expect(msgs(s).filter((m) => m.direction === 'incoming')).toHaveLength(2);
    expect(sends(s)).toHaveLength(1);
    expect(notif.notify).toHaveBeenCalledTimes(1);
    const human = await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/conversations/${conv(s)!.conversation.id}/messages`, { text: 'hi' });
    expect(human.status).toBe(409);
    expect(human.body.error.code).toBe('ACCOUNT_NOT_CONNECTED');

    // reconnecting restores sending
    await connected(s);
    expect(a!.ig.status(s.shopId).status).toBe('connected');
    expect(a!.vault.get(s.shopId, 'instagram')).toMatchObject({ status: 'active' });
  });

  it('shared accounts: none or several are refused and nothing is stored or subscribed', async () => {
    const s = await setup();
    for (const data of [[], [{ id: IG, username: 'a' }, { id: '17841400000000002', username: 'b' }]]) {
      s.meta.accounts = () => json({ data });
      const r = await connect(s);
      expect(r.res.headers.location).toBe('https://dash.example/?instagram=select_one');
      expect(a!.ig.status(s.shopId).status).toBe('not_connected');
      expect(a!.vault.get(s.shopId, 'instagram')).toBeUndefined();
    }
    expect(s.meta.calls.some((c) => c.url.includes('/subscribed_apps'))).toBe(false);
  });

  it('a rejected code or account lookup is an error redirect and stores nothing', async () => {
    const s = await setup();
    for (const bad of ['exchange', 'accounts'] as const) {
      s.meta[bad] = () => json({ error: { message: 'bad', code: 190 } }, 400);
      const r = await connect(s);
      expect(r.res.headers.location).toBe('https://dash.example/?instagram=error');
      expect(a!.ig.status(s.shopId).status).toBe('not_connected');
      expect(a!.vault.get(s.shopId, 'instagram')).toBeUndefined();
    }
  });

  it('there is no refresh call; a token known to be expired needs a reconnect without any Meta call, a live one is left alone', async () => {
    const s = await setup();
    await connected(s);
    const n = s.meta.calls.length;
    await a!.ig.expireDue(); // no expiry known (default configuration: never expires)
    a!.handle.raw.prepare('update instagram_channels set token_expires_at = ?').run(new Date(Date.now() + 86_400_000).toISOString());
    await a!.ig.expireDue();
    expect(a!.ig.status(s.shopId).status).toBe('connected');
    a!.handle.raw.prepare('update instagram_channels set token_expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    await a!.ig.expireDue();
    expect(a!.ig.status(s.shopId)).toMatchObject({ status: 'needs_reconnect', lastError: 'TOKEN_EXPIRED' });
    expect(s.meta.calls.length).toBe(n);
  });

  it('stores the expiry when Meta reports one', async () => {
    const s = await setup();
    s.meta.exchange = () => json({ access_token: TOKEN_LONG, token_type: 'bearer', expires_in: 5_184_000 });
    await connected(s);
    expect(Date.parse(a!.igRepo.getChannel(s.shopId)!.tokenExpiresAt!)).toBeGreaterThan(Date.now() + 50 * 86_400_000);
  });
});

describe('polling fallback', () => {
  const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '+0000'); // the format Meta uses
  const polled = (id: string, ms: number, text: string, own = false) => ({
    id,
    created_time: iso(ms),
    from: own ? { id: IG, username: 'shop_ig' } : { id: CUSTOMER, username: 'cust' },
    to: { data: [own ? { id: CUSTOMER, username: 'cust' } : { id: IG, username: 'shop_ig' }] },
    message: text,
  });
  const convs = (...messages: unknown[]) => json({ data: [{ id: 'c1', updated_time: iso(Date.now()), messages: { data: messages } }] });

  it('polls since connection without importing history; later runs ingest once and record our own messages as echoes', async () => {
    const s = await setup({ script: [say('Вітаю!')] });
    await connected(s);
    const old = polled('mid.old', Date.now() - 3_600_000, 'старе');
    s.meta.conversations = () => convs(old);
    expect(await a!.ig.pollOnce()).toBe(0);
    expect(conv(s)).toBeUndefined(); // no history import
    expect(a!.igRepo.getChannel(s.shopId)!.polledUntil).toBeTruthy();

    const fresh = polled('mid.p1', Date.now() + 2000, 'Привіт, є худі?');
    s.meta.conversations = () => convs(fresh, old);
    expect(await a!.ig.pollOnce()).toBe(1);
    await a!.salesAgent?.whenIdle();
    expect(runs(s)).toHaveLength(1);
    expect(sends(s)).toHaveLength(1);

    // the same data again changes nothing; our own reply shows up as an echo and is adopted, not duplicated
    const own = polled('mid.out1', Date.now() + 4000, 'Вітаю!', true);
    s.meta.conversations = () => convs(own, fresh, old);
    expect(await a!.ig.pollOnce()).toBe(0);
    expect(await a!.ig.pollOnce()).toBe(0);
    expect(runs(s)).toHaveLength(1);
    expect(sends(s)).toHaveLength(1);
    expect(msgs(s).map((m) => [m.direction, m.senderType, m.externalId])).toEqual([
      ['incoming', 'customer', 'mid.p1'],
      ['outgoing', 'ai', 'mid.out1'],
    ]);
  });

  it('a message already delivered by webhook is not stored again by the poll (same id)', async () => {
    const s = await setup({ script: [say('Вітаю!')] });
    await connected(s);
    s.meta.conversations = () => convs();
    await a!.ig.pollOnce();
    await webhook(inbound('mid.same', 'Привіт'));
    s.meta.conversations = () => convs(polled('mid.same', Date.now() + 2000, 'Привіт'));
    expect(await a!.ig.pollOnce()).toBe(0);
    expect(msgs(s).filter((m) => m.direction === 'incoming')).toHaveLength(1);
    expect(runs(s)).toHaveLength(1);
  });

  it('a rejected token during a poll needs a reconnect; other errors change nothing', async () => {
    const s = await setup();
    await connected(s);
    await a!.ig.pollOnce(); // cursor
    s.meta.conversations = () => json({ error: { code: 2 } }, 503);
    await a!.ig.pollOnce();
    expect(a!.ig.status(s.shopId).status).toBe('connected');
    s.meta.conversations = () => json({ error: { message: 'bad', code: 190 } }, 400);
    await a!.ig.pollOnce();
    expect(a!.ig.status(s.shopId)).toMatchObject({ status: 'needs_reconnect', lastError: 'TOKEN_REJECTED' });
  });

  it.each(['disconnect', 'switch', 'reconnect'] as const)('ignores a stale poll after %s', async (change) => {
    const s = await setup({ ai: false });
    await connected(s);
    let release!: (response: Response) => void;
    s.meta.conversations = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    const polling = a!.ig.pollOnce();
    if (change === 'disconnect') {
      await a!.ig.disconnect(s.shopId);
    } else {
      if (change === 'switch') s.meta.accounts = () => json({ data: [{ id: '17841400000000002', username: 'another_shop' }] });
      await connected(s);
    }
    const channelAfterChange = a!.igRepo.getChannel(s.shopId);
    // A response from the old token must neither ingest old-account messages nor invalidate the new token.
    release(change === 'reconnect' ? json({ error: { code: 190 } }, 401) : convs(polled('mid.stale', Date.now() + 2000, 'Old account')));
    expect(await polling).toBe(0);
    expect(conv(s)).toBeUndefined();
    expect(a!.igRepo.getChannel(s.shopId)).toEqual(channelAfterChange);
    if (change !== 'disconnect') expect(a!.vault.get(s.shopId, 'instagram')?.status).toBe('active');
  });
});

describe('secrets', () => {
  it('tokens, the app secret, signatures and provider text never reach the logs', async () => {
    const lines: string[] = [];
    const logStream = { write: (l: string) => void lines.push(l) } as unknown as NodeJS.WritableStream;
    const s = await setup({ script: [say('Привіт!'), say('Ще раз')], extra: { logger: true, logLevel: 'trace', logStream } });
    await connected(s);
    await webhook(inbound('mid.in1', 'Секретне повідомлення клієнта'));
    await webhook(inbound('mid.in2', 'x'), { sig: 'sha256=' + '0'.repeat(64) });
    s.meta.send = () => json({ error: { message: `Invalid token ${TOKEN_LONG} Leaky provider text`, type: 'OAuthException', code: 190 } }, 401);
    await webhook(inbound('mid.in3', 'Ще одне повідомлення'));
    await connected(s);
    await a!.ig.expireDue();
    await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/instagram`);
    const out = lines.join('\n');
    expect(out.length).toBeGreaterThan(200); // logging really was on
    for (const secret of [TOKEN_LONG, APP_SECRET, VERIFY, '0'.repeat(64), 'Leaky provider text', 'Секретне повідомлення']) expect(out, secret).not.toContain(secret);
    expect(out).not.toMatch(/access_token=|client_secret/);
  });

  it('API output never contains a token, in any state', async () => {
    const s = await setup({ script: [say('Привіт!')] });
    await connected(s);
    await webhook(inbound('mid.in1', 'Привіт'));
    const id = conv(s)!.conversation.id;
    const bodies = [
      await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/instagram`),
      await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/conversations`),
      await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/conversations/${id}/messages`),
      await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/channels`),
      await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/ai/runs`),
    ].map((r) => JSON.stringify(r.body));
    for (const b of bodies) for (const secret of [TOKEN_LONG, APP_SECRET, 'ciphertext', 'wrapped_key']) expect(b).not.toContain(secret);
  });
});

describe('deployment defaults', () => {
  it('expands a leading ~ in the data dir and db file (env files are not shell-expanded)', () => {
    const home = os.homedir();
    expect(loadConfig({ HEPSON_DATA_DIR: '~/.hepson' }).dataDir).toBe(path.join(home, '.hepson'));
    expect(loadConfig({ HEPSON_DATA_DIR: '~/.hepson' }).dbFile).toBe(path.join(home, '.hepson', 'hepson.db'));
    expect(loadConfig({ HEPSON_DB_FILE: '~/x/h.db' }).dbFile).toBe(path.join(home, 'x', 'h.db'));
    expect(loadConfig({ HEPSON_DATA_DIR: '/data/h' }).dataDir).toBe('/data/h');
    expect(loadConfig({ HEPSON_DATA_DIR: '~other/h' }).dataDir).toBe(path.resolve('~other/h')); // only the current user's home
  });

  it('the browser adapter is off by default and creating a browser account is refused', async () => {
    expect(loadConfig({}).enableBrowserAdapter).toBe(false);
    expect(loadConfig({ HEPSON_ENABLE_BROWSER_ADAPTER: 'true' }).enableBrowserAdapter).toBe(true);
    a = await makeApp({ enableBrowserAdapter: false });
    const r = await call(a, a.admin, 'POST', '/v1/accounts', { label: 'x', connectorType: 'instagram-browser', consentConfirmed: true });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain('deprecated');
    expect((await call(a, a.admin, 'POST', '/v1/accounts', { label: 'm', connectorType: 'mock', consentConfirmed: false })).status).toBe(201);
  });

  it('keeps the production allow-list: a configured Graph host outside it is the operator\'s explicit choice, anything else is refused', async () => {
    const s = await setup();
    await connected(s);
    // no outbound call in this test targeted a host other than the Graph host
    const hosts = new Set(s.meta.calls.map((c) => new URL(c.url).host));
    expect([...hosts]).toEqual(['graph.facebook.com']);
  });
});
