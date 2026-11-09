import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { INSTAGRAM_CHANNEL, Keyring, TELEGRAM_CHANNEL } from '@hepson/database';
import { LlmError } from '../../apps/api/src/agent/llm';
import { call, makeApp, type TestApp } from '../helpers';
import { FakeVision, NO_PRODUCT, jpeg } from '../fixtures/fake-vision';
import { ScriptedLlm, lastToolResult, say, useTool } from '../fixtures/scripted-llm';

// Telegram Bot API shapes (getFile, file URL) are from Telegram's public documentation. Instagram attachment payloads
// follow Meta's documented `payload.url`; the CDN host is unknown (D42), so tests use a made-up one.
const PW = 'correct horse battery';
const BOT = '7000000001:AAHk-shop-a-token-abcdefghijklmnopqrstu';
const CHAT = 5551230001;
const DRESS = 'https://shop.example/img/dress.jpg';
const TEE = 'https://shop.example/img/tee.jpg';

let a: TestApp | undefined;
afterEach(async () => {
  await a?.close();
  a?.cleanup();
  a = undefined;
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function fakeNet() {
  const n = {
    calls: [] as string[],
    hooks: [] as Array<{ url: string; secret_token: string }>,
    files: new Map<string, Buffer>([['photos/file_7.jpg', jpeg('customer-dress')]]),
    cdn: new Map<string, Buffer>([['https://scontent-waw.cdn-ig.example/m/1.jpg', jpeg('ig-tee')]]),
  };
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    n.calls.push(url);
    const file = /^https:\/\/api\.telegram\.org\/file\/bot[^/]+\/(.+)$/.exec(url);
    if (file)
      return n.files.has(file[1]!)
        ? new Response(new Uint8Array(n.files.get(file[1]!)!), { headers: { 'content-type': 'application/octet-stream' } })
        : new Response('', { status: 404 });
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    if (m) {
      const params = init?.body ? JSON.parse(String(init.body)) : {};
      if (m[2] === 'getMe') return json({ ok: true, result: { id: 7000000001, is_bot: true, username: 'shop_bot' } });
      if (m[2] === 'setWebhook') return (n.hooks.push(params), json({ ok: true, result: true }));
      if (m[2] === 'sendMessage') return json({ ok: true, result: { message_id: 1 } });
      if (m[2] === 'getFile')
        return params.file_id === 'BIG' ? json({ ok: true, result: { file_id: 'BIG', file_path: 'photos/file_7.jpg', file_size: 20 } }) : json({ ok: false }, 400);
    }
    if (n.cdn.has(url)) return new Response(new Uint8Array(n.cdn.get(url)!), { headers: { 'content-type': 'image/jpeg' } });
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  return Object.assign(n, { fetchImpl });
}

async function setup(o: { script?: ReturnType<typeof say>[] | ConstructorParameters<typeof ScriptedLlm>[0]; extraHosts?: string[]; vision?: FakeVision | null } = {}) {
  const net = fakeNet();
  const vision = o.vision === undefined ? new FakeVision() : o.vision;
  vision?.byUrl.set(DRESS, 'red linen midi dress, wooden buttons');
  vision?.byUrl.set(TEE, 'white cotton t-shirt, round neck');
  vision?.byBytes.set(jpeg('customer-dress').toString('latin1'), 'red linen dress midi length with buttons');
  vision?.byBytes.set(jpeg('ig-tee').toString('latin1'), 'white cotton t-shirt');
  const llm = new ScriptedLlm(o.script ?? []);
  a = await makeApp({ llm, vision, fetchImpl: net.fetchImpl, keyring: new Keyring(1, randomBytes(32)), publicUrl: 'https://hepson.example', egressExtraHosts: o.extraHosts ?? [] });
  await call(a, null, 'POST', '/v1/auth/register', { email: 'o@example.com', displayName: 'O', password: PW });
  const token = (await call(a, null, 'POST', '/v1/auth/login', { email: 'o@example.com', password: PW })).body.token as string;
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
  await call(a, token, 'PUT', `/v1/shops/${shopId}/ai`, { enabled: true });
  const base = `/v1/shops/${shopId}`;
  const dress = (
    await call(a, token, 'POST', `${base}/products`, { name: 'Сукня лляна', priceMinor: 129_900, media: [DRESS], variants: [{ sku: 'DR-S', options: { size: 'S' }, stock: 2 }] })
  ).body;
  const tee = (await call(a, token, 'POST', `${base}/products`, { name: 'Футболка біла', priceMinor: 45_000, media: [TEE], sku: 'TEE-1', stock: 5 })).body;
  await call(a, token, 'POST', `${base}/products`, { name: 'Шарф', priceMinor: 30_000, sku: 'SC-1', stock: 1 });
  await a.photos?.whenIdle();
  return { net, vision: vision!, llm, token, shopId, base, dress, tee };
}
type S = Awaited<ReturnType<typeof setup>>;

describe('photo index', () => {
  it('indexes each main image once, by URL handed to the provider (Hepson fetches nothing); tracks changes and failures', async () => {
    const s = await setup();
    expect((await call(a!, s.token, 'GET', `${s.base}/photo-index`)).body).toEqual({ available: true, withPhoto: 2, indexed: 2, failed: 0, pending: 0 });
    expect(s.vision.described).toEqual([{ url: DRESS }, { url: TEE }]);
    expect(s.net.calls.some((c) => c.includes('shop.example'))).toBe(false);
    expect(await a!.photoRepo.get(s.shopId, s.dress.productId)).toMatchObject({ status: 'ready', imageUrl: DRESS, description: 'red linen midi dress, wooden buttons' });

    // A product edit that keeps the main image does not re-index; a new main image does; a broken link fails once and stays failed.
    await call(a!, s.token, 'PATCH', `${s.base}/products/${s.tee.productId}`, { name: 'Футболка' });
    await a!.photos!.whenIdle();
    expect(s.vision.described).toHaveLength(2);
    s.vision.byUrl.set('https://shop.example/img/logo.png', NO_PRODUCT);
    await call(a!, s.token, 'PATCH', `${s.base}/products/${s.tee.productId}`, { media: ['https://shop.example/img/broken.jpg'] });
    await call(a!, s.token, 'PATCH', `${s.base}/products/${s.dress.productId}`, { media: ['https://shop.example/img/logo.png', DRESS] });
    await a!.photos!.whenIdle();
    expect((await call(a!, s.token, 'GET', `${s.base}/photo-index`)).body).toMatchObject({ withPhoto: 2, indexed: 0, failed: 2, pending: 0 });
    expect(await a!.photoRepo.get(s.shopId, s.tee.productId)).toMatchObject({ status: 'failed', error: 'IMAGE_UNREADABLE' });
    expect(await a!.photoRepo.get(s.shopId, s.dress.productId)).toMatchObject({ status: 'failed', error: 'NO_PRODUCT' });

    s.vision.byUrl.set('https://shop.example/img/broken.jpg', 'white cotton t-shirt');
    const mgr = await login('m@example.com');
    await call(a!, s.token, 'POST', `${s.base}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a!, mgr, 'POST', `${s.base}/photo-index/retry`)).status).toBe(403);
    expect((await call(a!, mgr, 'GET', `${s.base}/photo-index`)).status).toBe(200);
    await call(a!, s.token, 'POST', `${s.base}/photo-index/retry`);
    await a!.photos!.whenIdle();
    expect((await call(a!, s.token, 'GET', `${s.base}/photo-index`)).body).toMatchObject({ indexed: 1, failed: 1 });
  });

  it('a provider outage pauses indexing without marking anything failed', async () => {
    const vision = new (class extends FakeVision {
      override async describe(): Promise<never> {
        throw new LlmError('OpenAI HTTP 503', true, 503);
      }
    })();
    const s = await setup({ vision });
    expect((await call(a!, s.token, 'GET', `${s.base}/photo-index`)).body).toMatchObject({ indexed: 0, failed: 0, pending: 2 });
  });

  it('is unavailable without a vision model, and the agent is not offered the tool', async () => {
    const s = await setup({ vision: null, script: [say('Вітаю!')] });
    expect((await call(a!, s.token, 'GET', `${s.base}/photo-index`)).body).toEqual({ available: false, withPhoto: 0, indexed: 0, failed: 0, pending: 0 });
    await customerSends(s, INSTAGRAM_CHANNEL, [{ kind: 'image', ref: 'https://x.example/1.jpg' }]);
    await a!.salesAgent!.whenIdle();
    expect(s.llm.calls[0]!.tools.map((t) => t.name)).not.toContain('search_by_photo');
  });
});

async function login(email: string) {
  await call(a!, null, 'POST', '/v1/auth/register', { email, displayName: email, password: PW });
  return (await call(a!, null, 'POST', '/v1/auth/login', { email, password: PW })).body.token as string;
}

async function customerSends(s: S, channel: string, attachments: Array<{ kind: string; ref?: string }>, text: string | null = null) {
  const r = await a!.conversations.ingestMessage(s.shopId, {
    channel,
    conversationExternalId: 'c1',
    customer: { externalId: 'c1' },
    externalId: `m${Math.random()}`,
    text,
    attachments,
  });
  await a!.salesAgent!.trigger(s.shopId, r.conversation.id, r.message.id);
  return r.conversation.id;
}

describe('search_by_photo', () => {
  it('Telegram photo: the largest size is fetched through the Bot API, matched against the index, never stored', async () => {
    const s = await setup({
      script: [
        useTool('search_by_photo', {}),
        (req) => {
          const r = lastToolResult(req);
          expect(r.products).toHaveLength(1);
          expect(r.products[0]).toMatchObject({ match: 'close', name: 'Сукня лляна', variants: [{ sku: 'DR-S', priceMinor: 129_900, inStock: true }] });
          return say('Схоже, це Сукня лляна за 1299 грн, розмір S є. Підтверджуєте?');
        },
      ],
    });
    await call(a!, s.token, 'PUT', `${s.base}/telegram`, { token: BOT });
    const hook = s.net.hooks.at(-1)!;
    const update = {
      update_id: 1,
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT, type: 'private' },
        from: { id: CHAT, is_bot: false, first_name: 'Іра' },
        caption: 'Є така?',
        photo: [
          { file_id: 'SMALL', file_unique_id: 'a', width: 90, height: 90, file_size: 10 },
          { file_id: 'BIG', file_unique_id: 'b', width: 800, height: 800, file_size: 20 },
          { file_id: 'HUGE', file_unique_id: 'c', width: 4000, height: 4000, file_size: 9_000_000 },
        ],
      },
    };
    const res = await a!.app.inject({
      method: 'POST',
      url: new URL(hook.url).pathname,
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token },
      payload: JSON.stringify(update),
    });
    expect(res.statusCode).toBe(200);
    await a!.salesAgent!.whenIdle();

    const conv = (await a!.conversations.findConversationByExternal(s.shopId, TELEGRAM_CHANNEL, String(CHAT)))!;
    const items = (await a!.conversations.listMessages(s.shopId, conv.conversation.id, { limit: 10 })).items;
    expect(items[0]!.attachments).toEqual([{ kind: 'image', ref: 'BIG' }]);
    expect(items.at(-1)).toMatchObject({ senderType: 'ai', deliveryStatus: 'sent' });
    expect(s.vision.described.at(-1)).toEqual({ data: jpeg('customer-dress'), mime: 'image/jpeg' });
    // Customer bytes appear nowhere in the database.
    const dump = a!.handle.raw.prepare(`select group_concat(attachments, ' ') a from shop_messages`).get() as { a: string };
    expect(dump.a).not.toContain('customer-dress');
    expect(a!.handle.raw.prepare(`select count(*) n from product_photo_index where description like '%buttons%' and image_url not like 'https://shop.example/%'`).get()).toEqual({
      n: 0,
    });
  });

  it('Instagram photo: a CDN host outside the allow-list is never contacted and the agent is told to ask instead', async () => {
    const s = await setup({
      script: [
        useTool('search_by_photo', {}),
        (req) => {
          expect(lastToolResult(req).error).toMatch(/could not be read/);
          return say('Підкажіть, будь ласка, назву товару.');
        },
      ],
    });
    await customerSends(s, INSTAGRAM_CHANNEL, [{ kind: 'image', ref: 'https://scontent-waw.cdn-ig.example/m/1.jpg' }]);
    await a!.salesAgent!.whenIdle();
    expect(s.net.calls.some((c) => c.includes('cdn-ig.example'))).toBe(false);
  });

  it('Instagram shared post with the operator-allowed CDN host family matches; one search per run', async () => {
    let calls = 0;
    const s = await setup({
      extraHosts: ['.cdn-ig.example'],
      script: [
        useTool('search_by_photo', { limit: 2 }),
        (req) => {
          expect(lastToolResult(req).products.map((p: { name: string; match: string }) => [p.name, p.match])).toEqual([['Футболка біла', 'close']]);
          return useTool('search_by_photo', {}, 'again');
        },
        (req) => {
          calls = s.vision.described.filter((d) => 'data' in d).length;
          expect(lastToolResult(req).products).toHaveLength(1);
          return say('Схоже, це Футболка біла за 450 грн.');
        },
      ],
    });
    await customerSends(s, INSTAGRAM_CHANNEL, [{ kind: 'post', ref: 'https://scontent-waw.cdn-ig.example/m/1.jpg' }]);
    await a!.salesAgent!.whenIdle();
    expect(calls).toBe(1);
    expect(s.net.calls.filter((c) => c.includes('cdn-ig.example'))).toHaveLength(1);
  });

  it('no photo in this turn, a photo of nothing, and nothing similar are each answered without guessing', async () => {
    const s = await setup({
      script: [
        useTool('search_by_photo', {}),
        (req) => (expect(lastToolResult(req).error).toMatch(/no customer photo/), say('Надішліть, будь ласка, фото.')),
        useTool('search_by_photo', {}),
        (req) => (expect(lastToolResult(req).note).toMatch(/does not show a product/), say('Що саме шукаєте?')),
        useTool('search_by_photo', {}),
        (req) => (expect(lastToolResult(req)).toMatchObject({ products: [], note: expect.stringMatching(/Nothing similar/) }), say('Такого немає, підкажіть назву.')),
      ],
      extraHosts: ['.cdn-ig.example'],
    });
    await customerSends(s, INSTAGRAM_CHANNEL, [], 'Привіт');
    await a!.salesAgent!.whenIdle();
    s.net.cdn.set('https://scontent-waw.cdn-ig.example/m/2.jpg', jpeg('selfie'));
    s.vision.byBytes.set(jpeg('selfie').toString('latin1'), NO_PRODUCT);
    await customerSends(s, INSTAGRAM_CHANNEL, [{ kind: 'image', ref: 'https://scontent-waw.cdn-ig.example/m/2.jpg' }]);
    await a!.salesAgent!.whenIdle();
    s.net.cdn.set('https://scontent-waw.cdn-ig.example/m/3.jpg', jpeg('boots'));
    s.vision.byBytes.set(jpeg('boots').toString('latin1'), 'black leather ankle boots');
    await customerSends(s, INSTAGRAM_CHANNEL, [{ kind: 'image', ref: 'https://scontent-waw.cdn-ig.example/m/3.jpg' }]);
    await a!.salesAgent!.whenIdle();
    expect(s.llm.calls).toHaveLength(6);
  });
});
