import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, call, customerWrites as writes, type TestApp } from '../helpers';
import { randomBytes } from 'node:crypto';
import { Keyring, TELEGRAM_CHANNEL, WEB_CHANNEL } from '@hepson/database';
import { ScriptedLlm, say, useTool } from '../fixtures/scripted-llm';
import { NP_KEY, fakeNovaPoshta, npLookups, npOrder } from '../fixtures/fake-nova-poshta';
import type { Notification, Notifier } from '../../apps/api/src/services/notifier';

const PW = 'correct horse battery';
const THREAD = 'thread-olena';
const order = npOrder([{ sku: 'HOODIE-M', quantity: 2 }]);
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

async function login(email: string) {
  await call(a!, null, 'POST', '/v1/auth/register', { email, displayName: email, password: PW });
  return (await call(a!, null, 'POST', '/v1/auth/login', { email, password: PW })).body.token as string;
}

/** Shop with a catalog and the AI on; one existing conversation with Olena on `channel` (default: website chat). */
async function setup(llm: ScriptedLlm, o: { channel?: string } = {}) {
  const notifier = new FakeNotifier();
  a = await makeApp({ llm, notifier, keyring: new Keyring(1, randomBytes(32)), fetchImpl: fakeNovaPoshta().fetchFor() });
  const token = await login('o@example.com');
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
  await a.catalog.createProduct(shopId, {
    name: 'Худі Classic',
    description: 'Бавовна',
    priceMinor: 129_900,
    currency: 'UAH',
    variants: [{ sku: 'HOODIE-M', options: { size: 'M' }, stock: 3 }],
  });
  await call(a, token, 'PUT', `/v1/shops/${shopId}/ai`, { enabled: true });
  await call(a, token, 'PUT', `/v1/shops/${shopId}/nova-poshta/key`, { apiKey: NP_KEY });
  const channel = o.channel ?? WEB_CHANNEL;
  const conversationId = (await a.conversations.ensureConversation(shopId, { channel, conversationExternalId: THREAD, customer: { externalId: THREAD, displayName: 'Олена' } }))
    .conversation.id;
  return { token, shopId, channel, llm, notifier, conversationId, base: `/v1/shops/${shopId}/conversations/${conversationId}` };
}
type S = Awaited<ReturnType<typeof setup>>;
const customerWrites = (s: S, text: string) => writes(a!, s.shopId, THREAD, text, s.channel);
const msgs = async (s: S) => (await a!.conversations.listMessages(s.shopId, s.conversationId, { limit: 200 })).items;

describe('human takeover', () => {
  it('pausing mutes the agent without calling the model; resuming lets it answer again', async () => {
    const llm = new ScriptedLlm([]);
    const s = await setup(llm);
    const p = await call(a!, s.token, 'PUT', `${s.base}/ai`, { paused: true });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ aiPaused: true, aiPausedByUserId: expect.any(String) });

    await customerWrites(s, 'Привіт');
    expect(llm.calls).toHaveLength(0);
    expect((await a!.agentRepo.listRuns(s.shopId)).items).toMatchObject([{ status: 'skipped', detail: 'AI_PAUSED' }]);
    expect((await msgs(s)).filter((m) => m.senderType === 'ai')).toHaveLength(0);

    expect((await call(a!, s.token, 'PUT', `${s.base}/ai`, { paused: false })).body).toMatchObject({ aiPaused: false, aiPausedAt: null, aiPausedByUserId: null });
    llm.push(say('Вітаю!'));
    await customerWrites(s, 'Є хтось?');
    expect((await msgs(s)).filter((m) => m.senderType === 'ai')).toMatchObject([{ text: 'Вітаю!', deliveryStatus: 'sent' }]);
  });

  it('pause is idempotent and keeps the first pauser; the flag shows in list and get', async () => {
    const s = await setup(new ScriptedLlm([]));
    const first = (await call(a!, s.token, 'PUT', `${s.base}/ai`, { paused: true })).body;
    const mgr = await login('m@example.com');
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/members`, { email: 'm@example.com', role: 'manager' });
    const second = (await call(a!, mgr, 'PUT', `${s.base}/ai`, { paused: true })).body;
    expect(second).toMatchObject({ aiPausedAt: first.aiPausedAt, aiPausedByUserId: first.aiPausedByUserId });
    expect((await call(a!, mgr, 'GET', s.base)).body.aiPaused).toBe(true);
    const list = (await call(a!, mgr, 'GET', `/v1/shops/${s.shopId}/conversations`)).body.items as Array<{ conversationId: string; aiPaused: boolean }>;
    expect(list.find((c) => c.conversationId === s.conversationId)!.aiPaused).toBe(true);
    expect(list.filter((c) => c.aiPaused)).toHaveLength(1);
  });

  it('a human reply goes out through the channel, is attributed to the member, pauses the AI and is not duplicated', async () => {
    const llm = new ScriptedLlm([]);
    const s = await setup(llm);
    const r = await call(a!, s.token, 'POST', `${s.base}/messages`, { text: '  Вітаю, це менеджер.  ' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ senderType: 'human', text: 'Вітаю, це менеджер.', deliveryStatus: 'sent', aiPaused: true });
    expect(r.body.senderUserId).toEqual(expect.any(String));

    const human = (await msgs(s)).filter((m) => m.direction === 'outgoing' && m.text === 'Вітаю, це менеджер.');
    expect(human).toHaveLength(1);
    expect(human[0]).toMatchObject({ senderType: 'human', deliveryStatus: 'sent', externalId: expect.any(String) });
    expect((await call(a!, s.token, 'GET', s.base)).body.aiPaused).toBe(true);

    await customerWrites(s, 'Дякую');
    expect(llm.calls).toHaveLength(0);
  });

  it('refuses before recording or pausing when the channel cannot send; validates text; hides other shops', async () => {
    const s = await setup(new ScriptedLlm([]), { channel: TELEGRAM_CHANNEL });
    const before = (await msgs(s)).length;
    const r = await call(a!, s.token, 'POST', `${s.base}/messages`, { text: 'Привіт' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ACCOUNT_NOT_CONNECTED');
    expect(await msgs(s)).toHaveLength(before);
    expect((await call(a!, s.token, 'GET', s.base)).body.aiPaused).toBe(false);

    expect((await call(a!, s.token, 'POST', `${s.base}/messages`, { text: '   ' })).status).toBe(400);
    expect((await call(a!, s.token, 'POST', `${s.base}/messages`, { text: 'x'.repeat(1001) })).status).toBe(400);
    expect((await call(a!, s.token, 'POST', `${s.base}/messages`, { text: 'hi', senderType: 'ai' })).status).toBe(400);

    const outsider = await login('x@example.com');
    expect((await call(a!, outsider, 'POST', `${s.base}/messages`, { text: 'hi' })).status).toBe(404);
    expect((await call(a!, outsider, 'PUT', `${s.base}/ai`, { paused: true })).status).toBe(404);
    expect((await call(a!, a!.admin, 'POST', `${s.base}/messages`, { text: 'hi' })).status).toBe(401);
    expect((await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/conversations/${crypto.randomUUID()}/messages`, { text: 'hi' })).status).toBe(404);
  });
});

describe('notifications', () => {
  it('announces a new escalation once and a new order draft; nothing for a repeated escalation', async () => {
    const llm = new ScriptedLlm([
      useTool('escalate', { reason: 'Знижка' }),
      say('Передала менеджеру.'),
      npLookups(),
      useTool('create_order_draft', order),
      say('Менеджер підтвердить.'),
    ]);
    const s = await setup(llm);
    await customerWrites(s, 'Дайте знижку');
    expect(s.notifier.sent).toEqual([{ kind: 'escalation', shopId: s.shopId, conversationId: s.conversationId, reason: 'Знижка' }]);

    await a!.agentRepo.resolveEscalation(s.shopId, (await a!.agentRepo.listEscalations(s.shopId)).items[0]!.id, null);
    await customerWrites(s, 'Беру 2 худі M');
    expect(s.notifier.sent).toHaveLength(2);
    expect(s.notifier.sent[1]).toMatchObject({ kind: 'order_draft', shopId: s.shopId, currency: 'UAH', totalMinor: 259_800, itemCount: 1 });
  });

  it('announces a guard-blocked reply as an escalation', async () => {
    const s = await setup(new ScriptedLlm([say('Коштує 1 грн'), say('Коштує 2 грн')]));
    await customerWrites(s, 'Скільки?');
    expect(s.notifier.sent).toMatchObject([{ kind: 'escalation', shopId: s.shopId }]);
  });

  it('owner sets the Telegram chat, manager only reads, bad ids are rejected', async () => {
    const s = await setup(new ScriptedLlm([]));
    const url = `/v1/shops/${s.shopId}/notifications`;
    expect((await call(a!, s.token, 'GET', url)).body).toMatchObject({ telegram: { available: true, chatId: null } });
    expect((await call(a!, s.token, 'PUT', url, { telegramChatId: '-1001234567890' })).body.telegram.chatId).toBe('-1001234567890');
    expect((await call(a!, s.token, 'PUT', url, { telegramChatId: '@my_shop_chan' })).body.telegram.chatId).toBe('@my_shop_chan');
    expect((await call(a!, s.token, 'PUT', url, { telegramChatId: 'not a chat' })).status).toBe(400);
    expect((await call(a!, s.token, 'PUT', url, { chatId: '1' })).status).toBe(400);

    const mgr = await login('m@example.com');
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a!, mgr, 'GET', url)).status).toBe(200);
    expect((await call(a!, mgr, 'PUT', url, { telegramChatId: null })).status).toBe(403);
    expect((await call(a!, s.token, 'PUT', url, { telegramChatId: null })).body.telegram.chatId).toBeNull();
    expect((await call(a!, await login('x@example.com'), 'GET', url)).status).toBe(404);
  });
});

describe('statistics', () => {
  it('counts runs, tokens, replies, escalations and drafts of the shop only', async () => {
    const llm = new ScriptedLlm([
      say('Вітаю!'),
      useTool('escalate', { reason: 'Знижка' }),
      say('Передала менеджеру.'),
      npLookups(),
      useTool('create_order_draft', order),
      say('Менеджер підтвердить.'),
    ]);
    const s = await setup(llm);
    // Mirrored history counts as messages too (by ingest time): measure from the state after linking.
    const base = (await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/stats`)).body.messages;
    await customerWrites(s, 'Привіт');
    await customerWrites(s, 'Дайте знижку');
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/escalations/${(await a!.agentRepo.listEscalations(s.shopId)).items[0]!.id}/resolve`);
    await customerWrites(s, 'Беру 2 худі M');
    const draftId = (await a!.orders.listDrafts(s.shopId)).items[0]!.draft.id;
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/order-drafts/${draftId}/approve`, {});
    await call(a!, s.token, 'POST', `${s.base}/messages`, { text: 'Дякуємо за замовлення' });

    const r = await call(a!, s.token, 'GET', `/v1/shops/${s.shopId}/stats`);
    expect(r.status).toBe(200);
    expect(r.body.ai).toMatchObject({ runs: 3, byStatus: { replied: 2, escalated: 1 }, modelRequests: 6, inputTokens: 60, outputTokens: 30, replyRate: 2 / 3 });
    expect(r.body.messages).toMatchObject({ incoming: base.incoming + 3, outgoingAi: 3, outgoingHuman: base.outgoingHuman + 1, failedOutgoing: 0 });
    expect(r.body.escalations).toMatchObject({ opened: 1, resolved: 1, openNow: 0 });
    expect(r.body.escalations.avgResolutionSeconds).toBeGreaterThanOrEqual(0);
    // No sender settings: the COD order stays `cod_confirmed` (TTN not created); it still counts as approved.
    expect(r.body.orderDrafts).toMatchObject({ byStatus: { cod_confirmed: 1 }, approved: [{ currency: 'UAH', count: 1, totalMinor: 259_800 }] });
    expect(r.body.conversations).toMatchObject({ aiPausedNow: 1 });
    expect(r.body.conversations.active).toBeGreaterThanOrEqual(1);
    // P10: one row per UTC day of the 30-day period (31 days touched), zeros included; all activity is today.
    type Day = { date: string; runs: number; approved: number; revenueMinor: number; newCustomers: number; outgoingHuman: number };
    const days = r.body.daily as Day[];
    expect(days).toHaveLength(31);
    expect(r.body.currency).toBe('UAH');
    expect(days.at(-1)).toMatchObject({
      date: new Date().toISOString().slice(0, 10),
      runs: 3,
      replied: 2,
      escalated: 1,
      inputTokens: 60,
      outputTokens: 30,
      approved: 1,
      revenueMinor: 259_800,
    });
    expect(days.at(-1)!.newCustomers).toBe(r.body.conversations.newCustomers);
    expect(days.at(-1)!.outgoingHuman).toBe(r.body.messages.outgoingHuman);
    expect(days.slice(0, -1).every((d) => d.runs + d.approved + d.revenueMinor + d.newCustomers + d.outgoingHuman === 0)).toBe(true);

    // A second shop sees none of it.
    const t2 = await login('o2@example.com');
    const shop2 = (await call(a!, t2, 'POST', '/v1/shops', { name: 'Інший', slug: 'shop-two' })).body.shopId as string;
    const z = (await call(a!, t2, 'GET', `/v1/shops/${shop2}/stats`)).body;
    expect(z.ai).toMatchObject({ runs: 0, byStatus: {}, inputTokens: 0, replyRate: null });
    expect(z.messages).toMatchObject({ incoming: 0, outgoingAi: 0, outgoingHuman: 0 });
    expect(z.orderDrafts).toEqual({ byStatus: {}, approved: [] });
    expect(z.daily).toHaveLength(31);
    expect((z.daily as Array<{ runs: number; approved: number; newCustomers: number }>).every((d) => d.runs + d.approved + d.newCustomers === 0)).toBe(true);
  });

  it('respects the period, rejects bad ones, and hides the shop from outsiders', async () => {
    const s = await setup(new ScriptedLlm([say('Вітаю!')]));
    await customerWrites(s, 'Привіт');
    const url = `/v1/shops/${s.shopId}/stats`;
    const past = (await call(a!, s.token, 'GET', `${url}?from=2020-01-01T00:00:00Z&to=2020-02-01T00:00:00Z`)).body;
    expect(past.ai.runs).toBe(0);
    expect(past.period).toEqual({ from: '2020-01-01T00:00:00.000Z', to: '2020-02-01T00:00:00.000Z' });
    expect((await call(a!, s.token, 'GET', `${url}?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z`)).status).toBe(400);
    expect((await call(a!, s.token, 'GET', `${url}?from=2020-01-01T00:00:00Z&to=2023-01-01T00:00:00Z`)).status).toBe(400);
    expect((await call(a!, s.token, 'GET', `${url}?from=yesterday`)).status).toBe(400);
    expect((await call(a!, await login('x@example.com'), 'GET', url)).status).toBe(404);
    expect((await call(a!, a!.admin, 'GET', url)).status).toBe(401);
  });
});
