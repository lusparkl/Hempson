import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INSTAGRAM_CHANNEL, Keyring, TELEGRAM_CHANNEL, WEB_CHANNEL } from '@hepson/database';
import { call, makeApp, mockAccount, type TestApp } from '../helpers';
import { ScriptedLlm } from '../fixtures/scripted-llm';
import { NP } from '../fixtures/fake-nova-poshta';
import { noticeText } from '../../apps/api/src/services/customer-notices';
import type { Notification, Notifier } from '../../apps/api/src/services/notifier';

// Meta and Telegram payloads below are written from their public documentation, not captured from live accounts.
const PW = 'correct horse battery';
const IG = '17841400000000001';
const IG_CUSTOMER = '5551230001';
const APP_SECRET = 'app-secret-for-tests';
const BOT = '7000000001:AAHk-shop-a-token-abcdefghijklmnopqrstu';
const TG_CHAT = 5551239999;
const cfgOver = {
  publicUrl: 'https://hepson.example',
  dashboardUrl: 'https://dash.example',
  metaAppId: 'app-1',
  metaConfigId: 'cfg-1',
  metaAppSecret: APP_SECRET,
  metaVerifyToken: 'verify-me',
};

let a: TestApp | undefined;
afterEach(async () => {
  await a?.close();
  a?.cleanup();
  a = undefined;
});

class FakeNotifier implements Notifier {
  sent: Notification[] = [];
  notify(n: Notification) {
    this.sent.push(n);
  }
  async whenIdle() {}
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

/** One fetch for both platforms: Telegram Bot API by host, everything else is the Meta Graph fake. */
function fakePlatforms() {
  let n = 100; // above the inbound message ids: a Telegram chat numbers both directions in one sequence
  const f = { meta: [] as Array<{ url: string; body: any }>, tg: [] as Array<{ method: string; params: any }> };
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (u.host === 'api.telegram.org') {
      const method = u.pathname.split('/').at(-1)!;
      f.tg.push({ method, params: body ?? {} });
      if (method === 'getMe') return json({ ok: true, result: { id: 7000000001, is_bot: true, first_name: 'Shop', username: 'shop_bot' } });
      if (method === 'sendMessage') return json({ ok: true, result: { message_id: ++n, chat: { id: TG_CHAT, type: 'private' }, date: 1 } });
      return json({ ok: true, result: true });
    }
    if (u.pathname.endsWith('/messages')) f.meta.push({ url: String(input), body });
    if (u.pathname.endsWith('/oauth/access_token')) return json({ access_token: 'EAAB-system-user-token-0001', token_type: 'bearer' });
    if (u.pathname.endsWith('/me/assigned_instagram_accounts')) return json({ data: [{ id: IG, username: 'shop_ig' }] });
    if (u.pathname.endsWith('/conversations')) return json({ data: [] });
    if (u.pathname.endsWith('/subscribed_apps')) return json({ success: true });
    if (u.pathname.endsWith('/messages')) return json({ recipient_id: IG_CUSTOMER, message_id: `mid.out${++n}` });
    return json({ name: 'Іра', username: 'ira_k' });
  }) as typeof fetch;
  return Object.assign(f, { fetchImpl });
}

async function login(email: string) {
  await call(a!, null, 'POST', '/v1/auth/register', { email, displayName: email, password: PW });
  return (await call(a!, null, 'POST', '/v1/auth/login', { email, password: PW })).body.token as string;
}

async function setup(o: { dir?: string } = {}) {
  const fake = fakePlatforms();
  const notifier = new FakeNotifier();
  // AI stays off for the shop: every message below comes from the server.
  a = await makeApp({
    ...cfgOver,
    dir: o.dir,
    keyring: new Keyring(1, randomBytes(32)),
    fetchImpl: fake.fetchImpl,
    llm: new ScriptedLlm([]),
    notifier,
    paymentCheckMinutes: 0,
    novaPoshtaPollMinutes: 0,
  });
  const token = await login('o@example.com');
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
  a.catalog.createProduct(shopId, { name: 'Худі Classic', priceMinor: 129_900, currency: 'UAH', variants: [{ sku: 'HOODIE-M', options: { size: 'M' }, stock: 10 }] });
  return { fake, notifier, token, shopId, base: `/v1/shops/${shopId}` };
}
type S = Awaited<ReturnType<typeof setup>>;

const settle = async () => {
  await a!.payments.whenIdle();
  await a!.delivery.whenIdle();
  await a!.notices.whenIdle();
};

async function telegramConversation(s: S): Promise<string> {
  expect((await call(a!, s.token, 'PUT', `${s.base}/telegram`, { token: BOT })).status).toBe(200);
  const reg = s.fake.tg.find((c) => c.method === 'setWebhook')!.params;
  const update = {
    update_id: 900001,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: TG_CHAT, type: 'private' },
      from: { id: TG_CHAT, is_bot: false, first_name: 'Іра' },
      text: 'Хочу худі',
    },
  };
  const res = await a!.app.inject({
    method: 'POST',
    url: new URL(String(reg.url)).pathname,
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': String(reg.secret_token) },
    payload: JSON.stringify(update),
  });
  expect(res.statusCode).toBe(200);
  return a!.conversations.findConversationByExternal(s.shopId, TELEGRAM_CHANNEL, String(TG_CHAT))!.conversation.id;
}

async function instagramConversation(s: S): Promise<string> {
  const start = await call(a!, s.token, 'POST', `${s.base}/instagram/connect`);
  const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
  await a!.app.inject({ method: 'GET', url: `/public/instagram/callback?code=AQD-code&state=${encodeURIComponent(state)}` });
  const raw = JSON.stringify({
    object: 'instagram',
    entry: [
      { id: IG, time: Date.now(), messaging: [{ sender: { id: IG_CUSTOMER }, recipient: { id: IG }, timestamp: Date.now(), message: { mid: 'mid.in1', text: 'Хочу худі' } }] },
    ],
  });
  const sig = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  expect(
    (await a!.app.inject({ method: 'POST', url: '/webhooks/instagram', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, payload: raw })).statusCode,
  ).toBe(200);
  await a!.ig.whenIdle();
  return a!.conversations.findConversationByExternal(s.shopId, INSTAGRAM_CHANNEL, IG_CUSTOMER)!.conversation.id;
}

const webConversation = (s: S, session = 'web-session-1') =>
  a!.conversations.ensureConversation(s.shopId, { channel: WEB_CHANNEL, conversationExternalId: session, customer: { externalId: session, displayName: 'Відвідувач' } })
    .conversation.id;

/** A member-created draft with complete checkout data (COD unless switched to prepaid). */
function draftFor(s: S, conversationId: string, paymentMethod: 'cod' | 'prepaid' = 'cod') {
  const d = a!.orders.createDraft(s.shopId, {
    conversationId,
    createdBy: 'user',
    items: [{ sku: 'HOODIE-M', quantity: 2 }],
    checkout: {
      firstName: 'Олена',
      lastName: 'Коваль',
      phone: '050 111 22 33',
      npCityRef: NP.kyivRef,
      npCityName: 'Київ',
      npWarehouseRef: NP.branch5Ref,
      npWarehouseName: 'Відділення №5',
      paymentMethod: 'cod',
    },
  }).draft;
  // Prepaid needs a connected provider to be offered at checkout; the notice path only cares about the stored method.
  if (paymentMethod === 'prepaid') a!.handle.raw.prepare("update order_drafts set payment_method = 'prepaid' where id = ?").run(d.id);
  return d.id;
}

/** Repository-level shipping (the Nova Poshta calls themselves are covered by the P4 tests). */
function ship(s: S, draftId: string, ttn = '20450000000001') {
  a!.orders.claimTtn(s.shopId, draftId);
  a!.orders.completeTtn(s.shopId, draftId, { ttn, documentRef: 'doc-ref-1' });
}
const deliver = (s: S, draftId: string) => a!.orders.applyTracking(s.shopId, draftId, { code: '9', text: 'Відправлення отримано', outcome: 'delivered', refusal: false });
const notices = async (s: S, draftId: string) =>
  (await call(a!, s.token, 'GET', `${s.base}/order-drafts/${draftId}`)).body.customerNotices as Array<{ event: string; state: string; code: string | null }>;
const systemMessages = (s: S, conversationId: string) => a!.conversations.listMessages(s.shopId, conversationId, { limit: 100 }).items.filter((m) => m.senderType === 'system');
const draftRow = (s: S, id: string) => a!.orders.getDraft(s.shopId, id)!.draft;

describe('customer notices over Telegram', () => {
  it('confirmed, shipped and delivered go out once each with server text; replays and restarts add nothing', async () => {
    const s = await setup();
    const conv = await telegramConversation(s);
    const id = draftFor(s, conv);
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {})).body.status).toBe('cod_confirmed');
    await settle();
    ship(s, id);
    await settle();
    deliver(s, id);
    deliver(s, id); // the next tracking pass sees the same status
    await settle();

    const sends = s.fake.tg.filter((c) => c.method === 'sendMessage');
    expect(sends.map((c) => c.params.text)).toEqual(['confirmed', 'shipped', 'delivered'].map((e) => noticeText(e as never, draftRow(s, id), 'uk')));
    expect(sends.every((c) => c.params.chat_id === String(TG_CHAT) || c.params.chat_id === TG_CHAT)).toBe(true);
    expect(sends[0]!.params.text).toContain('2598 грн');
    expect(sends[0]!.params.text).toContain('Київ, Відділення №5');
    expect(sends[1]!.params.text).toContain('20450000000001');
    expect(systemMessages(s, conv).map((m) => m.deliveryStatus)).toEqual(['sent', 'sent', 'sent']);
    expect(await notices(s, id)).toMatchObject([
      { event: 'confirmed', state: 'sent', code: null },
      { event: 'shipped', state: 'sent' },
      { event: 'delivered', state: 'sent' },
    ]);

    // A second enqueue of the same event and a restart-style pass send nothing new.
    expect(a!.noticeRepo.enqueue(s.shopId, id, 'shipped')).toBe(false);
    a!.notices.start();
    a!.notices.kick();
    await settle();
    expect(s.fake.tg.filter((c) => c.method === 'sendMessage')).toHaveLength(3);
  });

  it('a rejected draft tells the customer, without the internal decision note', async () => {
    const s = await setup();
    const conv = await telegramConversation(s);
    const id = draftFor(s, conv);
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/reject`, { note: 'клієнт підозрілий' });
    await settle();
    const texts = s.fake.tg.filter((c) => c.method === 'sendMessage').map((c) => String(c.params.text));
    expect(texts).toEqual([noticeText('rejected', draftRow(s, id), 'uk')]);
    expect(texts[0]).not.toContain('підозрілий');
  });
});

describe('customer notices over Instagram', () => {
  it('inside the 24-hour window the notice is sent through the Send API', async () => {
    const s = await setup();
    const conv = await instagramConversation(s);
    const id = draftFor(s, conv);
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
    await settle();
    expect(s.fake.meta.map((c) => c.body?.message?.text)).toEqual([noticeText('confirmed', draftRow(s, id), 'uk')]);
    expect(s.fake.meta[0]!.body.recipient).toEqual({ id: IG_CUSTOMER });
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update' && n.event === 'customer_notice_undeliverable')).toHaveLength(0);
  });

  it('a closed window sends nothing, records the failure and tells the shop once', async () => {
    const s = await setup();
    const conv = await instagramConversation(s);
    const id = draftFor(s, conv);
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
    await settle();
    a!.handle.raw.prepare("update shop_messages set occurred_at = ? where direction = 'incoming'").run(new Date(Date.now() - 25 * 3_600_000).toISOString());
    ship(s, id, '20450000000777');
    await settle();
    a!.notices.kick();
    await settle();

    expect(s.fake.meta).toHaveLength(1); // only the confirmation from inside the window
    expect((await notices(s, id)).at(-1)).toMatchObject({ event: 'shipped', state: 'failed', code: 'OUTSIDE_MESSAGING_WINDOW' });
    expect(systemMessages(s, conv).at(-1)).toMatchObject({ deliveryStatus: 'failed', deliveryError: 'OUTSIDE_MESSAGING_WINDOW' });
    const alerts = s.notifier.sent.filter((n) => n.kind === 'order_update' && n.event === 'customer_notice_undeliverable');
    expect(alerts).toEqual([expect.objectContaining({ shopId: s.shopId, draftId: id, notice: 'shipped', reason: 'OUTSIDE_MESSAGING_WINDOW', ttn: '20450000000777' })]);
  });
});

describe('customer notices on website chat', () => {
  it('a verified payment tells the customer, stored where the visitor reads it', async () => {
    const s = await setup();
    const conv = webConversation(s);
    const id = draftFor(s, conv, 'prepaid');
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {})).body.status).toBe('awaiting_payment');
    await settle();
    // No provider here: the link creation fails (shop told), and approval of a prepaid order sends no `confirmed` notice.
    expect(systemMessages(s, conv)).toHaveLength(0);
    expect(a!.orders.markPaid(s.shopId, id, 'provider:monobank', 'invoice test')).toBe(true);
    await settle();
    const msgs = systemMessages(s, conv);
    expect(msgs.map((m) => m.text)).toEqual([noticeText('paid', draftRow(s, id), 'uk')]);
    expect(msgs[0]!.text).toContain('2598 грн');
    expect(msgs[0]).toMatchObject({ deliveryStatus: 'sent', direction: 'outgoing' });
  });

  it('a cancelled order or a notice older than a day is skipped, not sent', async () => {
    const s = await setup();
    const conv = webConversation(s);
    const id = draftFor(s, conv);
    a!.notices.stop();
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/cancel`, {});
    const id2 = draftFor(s, webConversation(s, 'web-session-2'));
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id2}/approve`, {});
    a!.handle.raw.prepare('update customer_notices set created_at = ? where draft_id = ?').run(new Date(Date.now() - 25 * 3_600_000).toISOString(), id2);
    // A fresh sender (what a restart builds) drains the queue.
    const { CustomerNoticeService } = await import('../../apps/api/src/services/customer-notices');
    const sender = new CustomerNoticeService({
      repo: a!.noticeRepo,
      orders: a!.orders,
      shops: a!.shops,
      send: async () => ({ status: 'sent', code: null }),
      log: { info() {}, warn() {} },
    });
    sender.start();
    await sender.whenIdle();
    expect(await notices(s, id)).toMatchObject([{ event: 'confirmed', state: 'skipped', code: 'ORDER_CANCELLED' }]);
    expect(await notices(s, id2)).toMatchObject([{ event: 'confirmed', state: 'skipped', code: 'STALE' }]);
  });
});

describe('restarts', () => {
  it('a pending notice goes out once after a restart; one interrupted mid-send becomes uncertain and is never resent', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hepson-test-'));
    let s = await setup({ dir });
    const conv = webConversation(s);
    const id = draftFor(s, conv);
    const id2 = draftFor(s, webConversation(s, 'web-session-2'));
    a!.notices.stop(); // the process "dies" before sending
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id2}/approve`, {});
    a!.handle.raw.prepare("update customer_notices set state = 'sending' where draft_id = ?").run(id2);
    const shopId = s.shopId;
    await a!.close();

    a = await makeApp({ ...cfgOver, dir, keyring: new Keyring(1, randomBytes(32)), llm: new ScriptedLlm([]), paymentCheckMinutes: 0, novaPoshtaPollMinutes: 0 });
    await a.notices.whenIdle();
    s = { ...s, shopId };
    expect(systemMessages(s, conv)).toHaveLength(1);
    expect(a.noticeRepo.listFor(shopId, id)).toMatchObject([{ state: 'sent' }]);
    expect(a.noticeRepo.listFor(shopId, id2)).toMatchObject([{ state: 'uncertain', code: 'INTERRUPTED' }]);
    expect(systemMessages(s, a.orders.getDraft(shopId, id2)!.draft.conversationId)).toHaveLength(0);
  });
});

describe('connector channel', () => {
  it('the mirrored copy of a notice adopts the system row instead of adding a human duplicate', async () => {
    const s = await setup();
    const acc = await mockAccount(a!);
    await a!.svc.syncOnce(acc);
    await call(a!, a!.admin, 'PUT', `/v1/accounts/${acc}/shop`, { shopId: s.shopId });
    await call(a!, a!.admin, 'PATCH', `/v1/accounts/${acc}/settings`, { outboundEnabled: true });
    const conv = a!.conversations.listConversations(s.shopId, {}).items[0]!.conversation.id;
    const id = draftFor(s, conv);
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
    await settle();
    await a!.svc.syncOnce(acc);
    const text = noticeText('confirmed', draftRow(s, id), 'uk');
    const copies = a!.conversations.listMessages(s.shopId, conv, { limit: 100 }).items.filter((m) => m.text === text);
    expect(copies).toEqual([expect.objectContaining({ senderType: 'system', deliveryStatus: 'sent' })]);
  });
});

describe('notice texts', () => {
  it('English for non-Ukrainian shops; null when the order lacks what the text needs', () => {
    const d = { id: 'abcdef12-0000-0000-0000-000000000000', totalMinor: 129_950, currency: 'UAH', npCityName: 'Kyiv', npWarehouseName: 'Branch 5', ttn: null } as never;
    expect(noticeText('confirmed', d, 'en')).toBe(
      'Order abcdef12 is confirmed. Total: 1299.50 UAH, cash on delivery.\nDelivery: Nova Poshta, Kyiv, Branch 5.\nWe will send the TTN number once the parcel is booked.',
    );
    expect(noticeText('shipped', d, 'en')).toBeNull();
    expect(noticeText('delivered', d, 'uk')).toBe('Замовлення abcdef12 отримано. Дякуємо за покупку!');
  });
});
