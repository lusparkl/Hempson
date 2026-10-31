import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keyring, TELEGRAM_CHANNEL } from '@hepson/database';
import { call, makeApp, type TestApp } from '../helpers';
import { ScriptedLlm, say, type Entry } from '../fixtures/scripted-llm';

// Bot API payloads and responses below are written from Telegram's public Bot API documentation.
const PW = 'correct horse battery';
const TOKEN_A = '7000000001:AAHk-shop-a-token-abcdefghijklmnopqrstu';
const TOKEN_B = '7000000002:AAHk-shop-b-token-abcdefghijklmnopqrstu';
const OPERATOR_TOKEN = '6000000000:AAOperator-notifier-token-abcdefghijk';
const CHAT = 5551230001;

let a: TestApp | undefined;
afterEach(async () => {
  await a?.close();
  a?.cleanup();
  a = undefined;
});

type Call = { token: string; method: string; params: Record<string, unknown> };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number) => json({ ok: false, error_code: status, description: 'irrelevant' }, status);

function fakeTelegram() {
  let n = 100;
  const t = {
    calls: [] as Call[],
    getMe: (token: string) => json({ ok: true, result: { id: Number(token.split(':')[0]), is_bot: true, first_name: 'Shop', username: `bot${token.split(':')[0]}` } }),
    setWebhook: () => json({ ok: true, result: true }),
    deleteWebhook: () => json({ ok: true, result: true }),
    sendMessage: (): Response | Promise<Response> => json({ ok: true, result: { message_id: ++n, chat: { id: CHAT, type: 'private' }, date: 1 } }),
  };
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(String(input));
    if (!m) throw new Error(`unexpected url ${String(input)}`);
    const [, token, method] = m as unknown as [string, string, keyof typeof t];
    t.calls.push({ token, method, params: init?.body ? JSON.parse(String(init.body)) : {} });
    const h = t[method];
    return typeof h === 'function' ? (h as (tok: string) => Response)(token) : err(404);
  }) as typeof fetch;
  return Object.assign(t, { fetchImpl });
}

async function login(email: string) {
  await call(a!, null, 'POST', '/v1/auth/register', { email, displayName: email, password: PW });
  return (await call(a!, null, 'POST', '/v1/auth/login', { email, password: PW })).body.token as string;
}

const notifier = () => ({ notify: vi.fn(), whenIdle: async () => {} });

async function setup(o: { script?: Entry[]; publicUrl?: string; keyring?: Keyring | null; notif?: ReturnType<typeof notifier> } = {}) {
  const tg = fakeTelegram();
  const llm = new ScriptedLlm(o.script ?? []);
  a = await makeApp({ publicUrl: o.publicUrl ?? 'https://hepson.example', keyring: o.keyring !== undefined ? o.keyring : new Keyring(1, randomBytes(32)), fetchImpl: tg.fetchImpl, llm, notifier: o.notif, telegramBotToken: OPERATOR_TOKEN });
  const token = await login('o@example.com');
  const shopId = await newShop(token, 'shop-one');
  return { tg, llm, token, shopId };
}
type S = Awaited<ReturnType<typeof setup>>;

async function newShop(token: string, slug: string) {
  const shopId = (await call(a!, token, 'POST', '/v1/shops', { name: 'Магазин', slug })).body.shopId as string;
  await call(a!, token, 'PUT', `/v1/shops/${shopId}/ai`, { enabled: true });
  return shopId;
}

/** Connects a bot and returns the webhook path and secret Hepson registered with Telegram. */
async function connect(s: S, shopId = s.shopId, botToken = TOKEN_A) {
  const res = await call(a!, s.token, 'PUT', `/v1/shops/${shopId}/telegram`, { token: botToken });
  const reg = s.tg.calls.filter((c) => c.method === 'setWebhook').at(-1);
  return { res, path: reg ? new URL(String(reg.params.url)).pathname : '', secret: reg ? String(reg.params.secret_token) : '' };
}

const update = (messageId: number, text: string | null, over: Record<string, unknown> = {}) => ({
  update_id: 900000 + messageId,
  message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: 'private', first_name: 'Іра' }, from: { id: CHAT, is_bot: false, first_name: 'Іра', last_name: 'К', username: 'ira_k' }, ...(text === null ? {} : { text }), ...over },
});

async function deliver(path: string, secret: string | null, payload: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  const res = await a!.app.inject({ method: 'POST', url: path, headers, payload: JSON.stringify(payload) });
  await a!.salesAgent?.whenIdle();
  return res;
}

const conv = (shopId: string) => a!.conversations.findConversationByExternal(shopId, TELEGRAM_CHANNEL, String(CHAT));
const msgs = (shopId: string) => a!.conversations.listMessages(shopId, conv(shopId)!.conversation.id, { limit: 100 }).items;
const sends = (s: S) => s.tg.calls.filter((c) => c.method === 'sendMessage');
const runs = (shopId: string) => a!.agentRepo.listRuns(shopId, { limit: 50 }).items;

describe('connect', () => {
  it('owner connects; token is checked, webhook registered with a secret, stored encrypted and never returned', async () => {
    const s = await setup();
    const { res, path, secret } = await connect(s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, status: 'connected', botUsername: 'bot7000000001' });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN_A);

    expect(s.tg.calls.map((c) => [c.token, c.method])).toEqual([
      [TOKEN_A, 'getMe'],
      [TOKEN_A, 'setWebhook'],
    ]);
    const reg = s.tg.calls[1]!.params;
    expect(path).toMatch(/^\/webhooks\/telegram\/[A-Za-z0-9_-]{32}$/);
    expect(String(reg.url)).not.toContain('7000000001'); // the path is opaque, never the token or bot id
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(reg.allowed_updates).toEqual(['message']);
    expect(reg.drop_pending_updates).toBe(true);

    expect(a!.vault.get(s.shopId, 'telegram_bot')?.status).toBe('active');
    // Neither the token nor the webhook secret is stored in plaintext anywhere in the database.
    const dump = JSON.stringify(a!.handle.raw.prepare("select * from telegram_channels").all()) + JSON.stringify(a!.handle.raw.prepare("select * from shop_credentials").all());
    expect(dump).not.toContain(TOKEN_A.split(':')[1]);
    expect(dump).not.toContain(secret);
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/telegram`)).body).toMatchObject({ status: 'connected' });
  });

  it('refuses a malformed token without calling Telegram, and a rejected token without storing anything', async () => {
    const s = await setup();
    expect((await call(a!, s.token, 'PUT', `/v1/shops/${s.shopId}/telegram`, { token: 'not-a-token' })).status).toBe(400);
    expect(s.tg.calls).toHaveLength(0);
    s.tg.getMe = () => err(401);
    const r = await call(a!, s.token, 'PUT', `/v1/shops/${s.shopId}/telegram`, { token: TOKEN_A });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN_A);
    expect(a!.vault.get(s.shopId, 'telegram_bot')).toBeUndefined();
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/telegram`)).body.status).toBe('not_connected');
  });

  it('does not connect when setWebhook fails', async () => {
    const s = await setup();
    s.tg.setWebhook = () => err(400);
    expect((await connect(s)).res.status).toBe(400);
    expect(a!.vault.get(s.shopId, 'telegram_bot')).toBeUndefined();
  });

  it('only the owner may connect or disconnect; members may read the state', async () => {
    const s = await setup();
    const mToken = await login('m@example.com');
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a!, mToken, 'PUT', `/v1/shops/${s.shopId}/telegram`, { token: TOKEN_A })).status).toBe(403);
    expect((await call(a!, mToken, 'DELETE', `/v1/shops/${s.shopId}/telegram`)).status).toBe(403);
    expect((await call(a!, mToken, 'GET', `/v1/shops/${s.shopId}/telegram`)).status).toBe(200);
    expect(s.tg.calls).toHaveLength(0);
  });

  it('is unavailable without a master key or an https public URL', async () => {
    let s = await setup({ keyring: null });
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/telegram`)).body.available).toBe(false);
    expect((await call(a!, s.token, 'PUT', `/v1/shops/${s.shopId}/telegram`, { token: TOKEN_A })).status).toBe(503);
    await a!.close();
    a!.cleanup();
    s = await setup({ publicUrl: 'http://127.0.0.1:8787' });
    expect((await call(a!, s.token, 'PUT', `/v1/shops/${s.shopId}/telegram`, { token: TOKEN_A })).status).toBe(503);
    expect(s.tg.calls).toHaveLength(0);
  });

  it('disconnect deletes the webhook with the shop token, the credential and the channel; the old path stops working', async () => {
    const s = await setup();
    const { path, secret } = await connect(s);
    expect((await call(a!, s.token, 'DELETE', `/v1/shops/${s.shopId}/telegram`)).status).toBe(200);
    expect(s.tg.calls.at(-1)).toMatchObject({ token: TOKEN_A, method: 'deleteWebhook' });
    expect(a!.vault.get(s.shopId, 'telegram_bot')).toBeUndefined();
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/telegram`)).body.status).toBe('not_connected');
    expect((await deliver(path, secret, update(1, 'Привіт'))).statusCode).toBe(401);
  });

  it('switching to another bot removes the old bot webhook and rotates path and secret', async () => {
    const s = await setup();
    const first = await connect(s);
    const second = await connect(s, s.shopId, TOKEN_B);
    expect(second.res.status).toBe(200);
    expect(s.tg.calls.filter((c) => c.method === 'deleteWebhook')).toEqual([expect.objectContaining({ token: TOKEN_A })]);
    expect(second.path).not.toBe(first.path);
    expect((await deliver(first.path, first.secret, update(1, 'x'))).statusCode).toBe(401);
  });
});

describe('webhook ingest and replies', () => {
  it('a valid update produces one agent run and one reply through the shop bot', async () => {
    const s = await setup({ script: [say('Вітаю! Чим допомогти?')] });
    const { path, secret } = await connect(s);
    const res = await deliver(path, secret, update(1, 'Привіт, є кросівки?'));
    expect(res.statusCode).toBe(200);

    const c = conv(s.shopId)!;
    expect(c.customer).toMatchObject({ externalId: String(CHAT), displayName: 'Іра К', handle: 'ira_k' });
    const m = msgs(s.shopId);
    expect(m.map((x) => [x.direction, x.text, x.externalId, x.deliveryStatus])).toEqual([
      ['incoming', 'Привіт, є кросівки?', `${CHAT}:1`, 'received'],
      ['outgoing', 'Вітаю! Чим допомогти?', `${CHAT}:101`, 'sent'],
    ]);
    expect(sends(s)).toEqual([{ token: TOKEN_A, method: 'sendMessage', params: { chat_id: String(CHAT), text: 'Вітаю! Чим допомогти?', link_preview_options: { is_disabled: true } } }]);
    expect(runs(s.shopId).map((r) => r.status)).toEqual(['replied']);
  });

  it('a redelivered update is stored once and answered once', async () => {
    const s = await setup({ script: [say('Привіт!')] });
    const { path, secret } = await connect(s);
    await deliver(path, secret, update(7, 'Привіт'));
    expect((await deliver(path, secret, update(7, 'Привіт'))).statusCode).toBe(200);
    expect(msgs(s.shopId).filter((m) => m.direction === 'incoming')).toHaveLength(1);
    expect(runs(s.shopId)).toHaveLength(1);
    expect(sends(s)).toHaveLength(1);
  });

  it('a wrong, missing or malformed secret is rejected and stores nothing', async () => {
    const s = await setup();
    const { path, secret } = await connect(s);
    for (const bad of [null, 'x'.repeat(secret.length), `${secret}x`, 'bad secret!']) {
      expect((await deliver(path, bad, update(1, 'Привіт'))).statusCode).toBe(401);
    }
    expect((await deliver('/webhooks/telegram/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', secret, update(1, 'Привіт'))).statusCode).toBe(401);
    expect(conv(s.shopId)).toBeUndefined();
    expect(runs(s.shopId)).toHaveLength(0);
  });

  it('ignores groups, bots, service messages and non-message updates', async () => {
    const s = await setup();
    const { path, secret } = await connect(s);
    for (const p of [
      update(1, 'hi', { chat: { id: -100123, type: 'group', title: 'g' } }),
      update(2, 'hi', { from: { id: 42, is_bot: true, first_name: 'b' } }),
      update(3, null, { new_chat_title: 'x' }),
      { update_id: 1, edited_message: update(4, 'edited').message },
      { update_id: 2 },
      'not an object',
    ]) {
      expect((await deliver(path, secret, p)).statusCode).toBe(200);
    }
    expect(conv(s.shopId)).toBeUndefined();
  });

  it('stores a photo with caption as text plus an image attachment', async () => {
    const s = await setup({ script: [say('Гарне фото!')] });
    const { path, secret } = await connect(s);
    await deliver(path, secret, update(1, null, { photo: [{ file_id: 'f', width: 1, height: 1 }], caption: 'Такі є?' }));
    expect(msgs(s.shopId)[0]).toMatchObject({ text: 'Такі є?', attachments: [{ kind: 'image' }] });
  });

  it('a customer who blocked the bot: the reply is failed, not retried', async () => {
    const s = await setup({ script: [say('Вітаю!')] });
    const { path, secret } = await connect(s);
    s.tg.sendMessage = () => err(403);
    await deliver(path, secret, update(1, 'Привіт'));
    expect(msgs(s.shopId).at(-1)).toMatchObject({ direction: 'outgoing', deliveryStatus: 'failed', deliveryError: 'BOT_BLOCKED' });
    expect(runs(s.shopId)[0]).toMatchObject({ status: 'failed', detail: 'BOT_BLOCKED' });
    expect(sends(s)).toHaveLength(1);
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/telegram`)).body.status).toBe('connected');
  });

  it('a timeout is uncertain and never retried', async () => {
    const s = await setup({ script: [say('Вітаю!')] });
    const { path, secret } = await connect(s);
    s.tg.sendMessage = () => Promise.reject(new Error('socket hang up'));
    await deliver(path, secret, update(1, 'Привіт'));
    expect(msgs(s.shopId).at(-1)).toMatchObject({ deliveryStatus: 'uncertain' });
    expect(runs(s.shopId)[0]!.status).toBe('send_uncertain');
    expect(sends(s)).toHaveLength(1);
  });

  it('a revoked token marks the channel for reconnect and tells the owner through the operator bot', async () => {
    const notif = notifier();
    const s = await setup({ script: [say('Вітаю!')], notif });
    const { path, secret } = await connect(s);
    s.tg.sendMessage = () => err(401);
    await deliver(path, secret, update(1, 'Привіт'));
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/telegram`)).body).toMatchObject({ status: 'needs_reconnect', lastError: 'TOKEN_REJECTED' });
    expect(a!.vault.get(s.shopId, 'telegram_bot')?.status).toBe('needs_reconnect');
    expect(notif.notify).toHaveBeenCalledWith({ kind: 'channel_issue', shopId: s.shopId, channel: 'telegram', issue: 'needs_reconnect' });
  });

  it('a human reply from the dashboard goes out through the bot and pauses the AI', async () => {
    const s = await setup({ script: [say('Вітаю!')] });
    const { path, secret } = await connect(s);
    await deliver(path, secret, update(1, 'Привіт'));
    const r = await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/conversations/${conv(s.shopId)!.conversation.id}/messages`, { text: 'Це менеджер' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ deliveryStatus: 'sent', aiPaused: true });
    expect(sends(s).at(-1)!.params.text).toBe('Це менеджер');
  });

  it('a human reply after disconnect is refused before anything is recorded', async () => {
    const s = await setup({ script: [say('Вітаю!')] });
    const { path, secret } = await connect(s);
    await deliver(path, secret, update(1, 'Привіт'));
    await call(a!, s.token, 'DELETE', `/v1/shops/${s.shopId}/telegram`);
    const before = msgs(s.shopId).length;
    expect((await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/conversations/${conv(s.shopId)!.conversation.id}/messages`, { text: 'x' })).status).toBe(409);
    expect(msgs(s.shopId)).toHaveLength(before);
  });
});

describe('isolation between shops', () => {
  it('one bot cannot serve two shops; each shop path only accepts its own secret and writes only to its shop', async () => {
    const s = await setup({ script: [say('A'), say('B')] });
    const shopB = await newShop(s.token, 'shop-two');
    const a1 = await connect(s);
    const taken = await call(a!, s.token, 'PUT', `/v1/shops/${shopB}/telegram`, { token: TOKEN_A });
    expect(taken.status).toBe(400);
    const b1 = await connect(s, shopB, TOKEN_B);
    expect(b1.res.status).toBe(200);

    expect((await deliver(a1.path, b1.secret, update(1, 'x'))).statusCode).toBe(401);
    await deliver(a1.path, a1.secret, update(1, 'для A'));
    await deliver(b1.path, b1.secret, update(1, 'для B'));
    expect(msgs(s.shopId).map((m) => m.text)).toEqual(['для A', 'A']);
    expect(msgs(shopB).map((m) => m.text)).toEqual(['для B', 'B']);
    // Each reply went through its own shop's bot; the operator notifier token was never used for customers.
    expect(sends(s).map((c) => c.token)).toEqual([TOKEN_A, TOKEN_B]);
    expect(s.tg.calls.some((c) => c.token === OPERATOR_TOKEN)).toBe(false);
  });
});
