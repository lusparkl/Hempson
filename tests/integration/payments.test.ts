import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Keyring } from '@hepson/database';
import { call, makeApp, mockAccount, type TestApp } from '../helpers';
import { ScriptedLlm, lastToolResult, say, useTool, type Entry } from '../fixtures/scripted-llm';
import { NP, NP_KEY, fakeNovaPoshta, npLookups, npOrder } from '../fixtures/fake-nova-poshta';
import { MONO_TOKEN, fakeMonobank, newEcKey, type FakeMono } from '../fixtures/fake-monobank';
import { TOOLS } from '../../apps/api/src/agent/tools';
import type { Notification, Notifier } from '../../apps/api/src/services/notifier';

// Monobank behaviour below is the fake in tests/fixtures/fake-monobank.ts, written from Monobank's acquiring documentation.
const PW = 'correct horse battery';
const THREAD = 'mock-thread-olena';
const PUBLIC = 'https://hepson.example';
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

async function setup(script: Entry[] = [], o: { mono?: boolean } = {}) {
  const np = fakeNovaPoshta();
  const mono = fakeMonobank();
  const llm = new ScriptedLlm(script);
  const notifier = new FakeNotifier();
  a = await makeApp({ llm, notifier, keyring: new Keyring(1, randomBytes(32)), fetchImpl: np.fetchFor(mono.fetchFor()), publicUrl: PUBLIC, paymentCheckMinutes: 0, novaPoshtaPollMinutes: 0 });
  const token = await login('o@example.com');
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
  a.catalog.createProduct(shopId, { name: 'Худі Classic', priceMinor: 129_900, currency: 'UAH', variants: [{ sku: 'HOODIE-M', options: { size: 'M' }, stock: 3 }] });
  const acc = await mockAccount(a);
  await a.svc.syncOnce(acc);
  await call(a, a.admin, 'PUT', `/v1/accounts/${acc}/shop`, { shopId });
  await call(a, a.admin, 'PATCH', `/v1/accounts/${acc}/settings`, { outboundEnabled: true });
  await call(a, token, 'PUT', `/v1/shops/${shopId}/ai`, { enabled: true });
  const base = `/v1/shops/${shopId}`;
  expect((await call(a, token, 'PUT', `${base}/nova-poshta/key`, { apiKey: NP_KEY })).status).toBe(200);
  await call(a, token, 'PUT', `${base}/nova-poshta/settings`, { senderCityRef: NP.kyivRef, senderCityName: 'Київ', senderWarehouseRef: NP.branch12Ref, senderWarehouseName: 'Відділення №12', prepaidEnabled: true });
  if (o.mono !== false) expect((await call(a, token, 'PUT', `${base}/monobank/token`, { token: MONO_TOKEN })).status).toBe(200);
  return { np, mono, llm, notifier, token, shopId, acc, base };
}
type S = Awaited<ReturnType<typeof setup>>;
const customerWrites = async (s: S, text: string) => {
  a!.mock.devInjectIncoming(s.acc, THREAD, text);
  await a!.svc.syncOnce(s.acc);
  await settle();
};
const settle = async () => {
  await a!.salesAgent!.whenIdle();
  await a!.payments.whenIdle();
  await a!.delivery.whenIdle();
};
const draft = (s: S) => a!.orders.listDrafts(s.shopId).items[0]!.draft;
const stock = (s: S) => a!.catalog.findVariantBySku(s.shopId, 'HOODIE-M')!.stock;
const PREPAID = npOrder([{ sku: 'HOODIE-M', quantity: 2 }], { paymentMethod: 'prepaid' });
const orderScript = (): Entry[] => [npLookups(), useTool('create_order_draft', PREPAID), say('Записала замовлення, магазин його підтвердить.')];
const webhookPath = (s: S) => `/webhooks/monobank/${a!.paymentRepo.getSettings(s.shopId).webhookId}`;
const post = (path: string, raw: string, sign?: string) => a!.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', ...(sign ? { 'x-sign': sign } : {}) }, payload: raw });
const ttnSaves = (s: S) => s.np.calls.filter((c) => c.modelName === 'InternetDocument' && c.calledMethod === 'save');
const systemMessages = (s: S) => a!.conversations.listMessages(s.shopId, draft(s).conversationId, { limit: 50 }).items.filter((m) => m.senderType === 'system');
const sql = (q: string, ...p: unknown[]) => a!.handle.raw.prepare(q).run(...p);

/** A prepaid AI order approved by the owner: the link is created and sent. */
async function approvedPrepaid(s: S) {
  await customerWrites(s, 'Беру 2 худі M, оплачу карткою');
  const id = draft(s).id;
  const r = await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
  expect(r.body.status).toBe('awaiting_payment');
  await settle();
  const pay = a!.paymentRepo.activeFor(s.shopId, id)!;
  return { id, pay };
}
const pay = (s: S, m: FakeMono, invoiceId: string, status = 'success', over = {}) => {
  const body = m.setStatus(invoiceId, status, over);
  return m.webhook({ ...body, ...over });
};

describe('Monobank connection', () => {
  it('owner connects the token (checked with Monobank, never returned); prepaid is offered only while connected', async () => {
    const s = await setup([], { mono: false });
    const url = `${s.base}/monobank`;
    expect((await call(a!, s.token, 'GET', url)).body).toMatchObject({ available: true, status: 'not_connected', paymentTimeoutHours: 24, reminderHoursBefore: 6 });
    expect(a!.deliveryRepo.paymentMethods(s.shopId, {}).methods).toEqual(['cod']);
    expect((await call(a!, s.token, 'PUT', `${url}/token`, { token: 'short' })).status).toBe(400);
    expect((await call(a!, s.token, 'PUT', `${url}/token`, { token: 'not-the-right-token-0123456789' })).status).toBe(400);
    expect(a!.vault.get(s.shopId, 'monobank')).toBeUndefined();

    const ok = await call(a!, s.token, 'PUT', `${url}/token`, { token: MONO_TOKEN });
    expect(ok.body).toMatchObject({ status: 'connected', merchantName: 'ФОП Тест', webhookReady: true });
    expect(JSON.stringify(ok.body)).not.toContain(MONO_TOKEN);
    expect(JSON.stringify((await call(a!, s.token, 'GET', url)).body)).not.toContain(MONO_TOKEN);
    expect(a!.deliveryRepo.paymentMethods(s.shopId, {}).methods).toEqual(['cod', 'prepaid']);

    const mgr = await login('m@example.com');
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a!, mgr, 'GET', url)).status).toBe(200);
    expect((await call(a!, mgr, 'PUT', `${url}/token`, { token: MONO_TOKEN })).status).toBe(403);
    expect((await call(a!, mgr, 'PUT', `${url}/settings`, { paymentTimeoutHours: 12 })).status).toBe(403);
    expect((await call(a!, s.token, 'PUT', `${url}/settings`, { paymentTimeoutHours: 12, reminderHoursBefore: 12 })).status).toBe(400);
    expect((await call(a!, s.token, 'PUT', `${url}/settings`, { paymentTimeoutHours: 12, reminderHoursBefore: 3 })).body).toMatchObject({ paymentTimeoutHours: 12, reminderHoursBefore: 3 });

    expect((await call(a!, s.token, 'DELETE', `${url}/token`)).body.status).toBe('not_connected');
    expect(a!.deliveryRepo.paymentMethods(s.shopId, {}).methods).toEqual(['cod']);
  });

  it('a token Monobank stops accepting marks the shop for reconnect and tells the owner once', async () => {
    const s = await setup(orderScript());
    s.mono.validTokens.clear();
    await customerWrites(s, 'Беру');
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${draft(s).id}/approve`, {});
    await settle();
    expect((await call(a!, s.token, 'GET', `${s.base}/monobank`)).body).toMatchObject({ status: 'needs_reconnect', lastError: 'TOKEN_REJECTED' });
    expect(s.notifier.sent.filter((n) => n.kind === 'channel_issue')).toEqual([{ kind: 'channel_issue', shopId: s.shopId, channel: 'monobank', issue: 'needs_reconnect' }]);
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update')).toMatchObject([{ event: 'payment_link_failed' }]);
  });
});

describe('payment link', () => {
  it('approval creates one invoice for the server total and sends the fixed-template link; no TTN before payment', async () => {
    const s = await setup(orderScript());
    const { id, pay: p } = await approvedPrepaid(s);
    const create = s.mono.only('/api/merchant/invoice/create');
    expect(create).toHaveLength(1);
    expect(create[0]!.body).toMatchObject({ amount: 259_800, ccy: 980, paymentType: 'debit', merchantPaymInfo: { reference: id }, webHookUrl: `${PUBLIC}${webhookPath(s)}` });
    expect(create[0]!.body.validity).toBeGreaterThan(23 * 3600);
    expect(create[0]!.body.validity).toBeLessThanOrEqual(24 * 3600);
    expect(p).toMatchObject({ state: 'created', amountMinor: 259_800, currency: 'UAH', pageUrl: `https://pay.mbnk.biz/${p.invoiceId}`, linkDelivery: 'sent' });
    const msgs = systemMessages(s);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain(`https://pay.mbnk.biz/${p.invoiceId}`);
    expect(msgs[0]!.text).toContain('До сплати: 2598 грн');
    expect(ttnSaves(s)).toHaveLength(0);
    expect(draft(s).paymentDueAt).toBe(p.expiresAt);
    // One active link per order.
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/payment-link`, {})).status).toBe(400);
    expect((await call(a!, s.token, 'GET', `${s.base}/order-drafts/${id}`)).body.payment).toMatchObject({ dueAt: p.expiresAt, latest: { state: 'created', pageUrl: p.pageUrl } });
  });

  it('the model has no tool that accepts an amount or creates a link', () => {
    const json = JSON.stringify(TOOLS.map((t) => t.parameters));
    expect(json).not.toMatch(/amount|price|total|sum|url|link/i);
    expect(TOOLS.map((t) => t.name)).not.toContain('create_payment_link');
  });

  it('Monobank fails to create the invoice: the shop is told; a member retries and the link goes out', async () => {
    const s = await setup(orderScript());
    s.mono.override.set('/api/merchant/invoice/create', () => new Response('{}', { status: 500 }));
    await customerWrites(s, 'Беру');
    const id = draft(s).id;
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
    await settle();
    expect(a!.paymentRepo.activeFor(s.shopId, id)).toBeUndefined();
    expect(a!.paymentRepo.listFor(s.shopId, id)).toMatchObject([{ state: 'create_failed', flag: 'MONO_UNAVAILABLE_HTTP_500' }]);
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update')).toMatchObject([{ event: 'payment_link_failed', draftId: id }]);
    s.mono.override.clear();
    const r = await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/payment-link`, {});
    expect(r.body.payment.latest).toMatchObject({ state: 'created', linkDelivery: 'sent' });
    expect(systemMessages(s)).toHaveLength(1);
  });

  it('a link the customer cannot receive is passed to the shop', async () => {
    const s = await setup(orderScript());
    await customerWrites(s, 'Беру');
    await call(a!, a!.admin, 'PATCH', `/v1/accounts/${s.acc}/settings`, { outboundEnabled: false });
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${draft(s).id}/approve`, {});
    await settle();
    const p = a!.paymentRepo.activeFor(s.shopId, draft(s).id)!;
    expect(p.linkDelivery).toMatch(/^failed:/);
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update')).toMatchObject([{ event: 'payment_link_undeliverable', link: p.pageUrl }]);
  });

  it('auto_confirm sends the link by itself and the AI reply still goes out', async () => {
    const s = await setup([
      npLookups(),
      useTool('create_order_draft', PREPAID),
      (req) => (expect(lastToolResult(req)).toMatchObject({ status: 'awaiting_payment', confirmed: true }), say('Замовлення підтверджено, посилання на оплату вже в чаті.')),
    ]);
    await call(a!, s.token, 'PUT', `${s.base}/ai`, { autonomy: 'auto_confirm' });
    await customerWrites(s, 'Беру, оплачу карткою');
    expect(a!.agentRepo.listRuns(s.shopId).items[0]!.status).toBe('replied');
    expect(systemMessages(s)).toHaveLength(1);
    expect(draft(s).status).toBe('awaiting_payment');
  });
});

describe('webhooks (D24)', () => {
  it('a signed success marks the order paid once and starts the prepaid TTN; a replay changes nothing', async () => {
    const s = await setup(orderScript());
    const { id, pay: p } = await approvedPrepaid(s);
    const w = pay(s, s.mono, p.invoiceId!);
    expect((await post(webhookPath(s), w.raw, w.sign)).statusCode).toBe(200);
    await settle();
    expect(draft(s)).toMatchObject({ status: 'shipped', ttnState: 'created' });
    expect(ttnSaves(s)).toHaveLength(1);
    expect(ttnSaves(s)[0]!.props).not.toHaveProperty('BackwardDeliveryData');
    const events = a!.orders.listEvents(s.shopId, id).map((e) => [e.toStatus, e.actor]);
    expect(events.slice(-2)).toEqual([
      ['paid', 'provider:monobank'],
      ['shipped', 'provider:nova_poshta'],
    ]);
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update').map((n) => (n as { event: string }).event)).toEqual(['paid']);

    expect((await post(webhookPath(s), w.raw, w.sign)).statusCode).toBe(200);
    await settle();
    expect(a!.orders.listEvents(s.shopId, id).filter((e) => e.toStatus === 'paid')).toHaveLength(1);
    expect(a!.paymentRepo.listEvents(s.shopId, p.id)).toHaveLength(1);
    expect(ttnSaves(s)).toHaveLength(1);
  });

  it('forged, unsigned, foreign-key and unknown-path webhooks change nothing and store nothing', async () => {
    const s = await setup(orderScript());
    const { pay: p } = await approvedPrepaid(s);
    const body = { ...s.mono.statusBody(s.mono.invoices.get(p.invoiceId!)!), status: 'success', modifiedDate: '2026-11-01T11:00:00Z' };
    const good = s.mono.webhook(body);
    const forged = s.mono.webhook(body, newEcKey().privateKey);
    expect((await post(webhookPath(s), forged.raw, forged.sign)).statusCode).toBe(401);
    expect((await post(webhookPath(s), good.raw)).statusCode).toBe(401);
    expect((await post(webhookPath(s), good.raw.replace('"success"', '"success" '), good.sign)).statusCode).toBe(401);
    expect((await post('/webhooks/monobank/AAAAAAAAAAAAAAAAAAAAAAAA', good.raw, good.sign)).statusCode).toBe(401);
    expect(draft(s).status).toBe('awaiting_payment');
    expect(a!.paymentRepo.listEvents(s.shopId, p.id)).toHaveLength(0);
    expect(a!.handle.raw.prepare('select count(*) n from payment_events').get()).toEqual({ n: 0 });
  });

  it('a rotated Monobank key is fetched once after a failed check, and a burst of forgeries does not refetch it', async () => {
    const s = await setup(orderScript());
    const { pay: p } = await approvedPrepaid(s);
    s.mono.rotateKey();
    sql('update shop_payment_settings set provider_pub_key_at = ? where shop_id = ?', '2000-01-01T00:00:00.000Z', s.shopId);
    const w = pay(s, s.mono, p.invoiceId!);
    expect((await post(webhookPath(s), w.raw, w.sign)).statusCode).toBe(200);
    await settle();
    expect(draft(s).status).toBe('shipped');
    const keys = s.mono.only('/api/merchant/pubkey').length;
    const forged = s.mono.webhook({ ...JSON.parse(w.raw), status: 'reversed' }, newEcKey().privateKey);
    for (let i = 0; i < 3; i++) expect((await post(webhookPath(s), forged.raw, forged.sign)).statusCode).toBe(401);
    expect(s.mono.only('/api/merchant/pubkey')).toHaveLength(keys);
  });

  it('out of order: an older status after success changes nothing; reversed after success tells the shop', async () => {
    const s = await setup(orderScript());
    const { id, pay: p } = await approvedPrepaid(s);
    const processing = pay(s, s.mono, p.invoiceId!, 'processing');
    const success = pay(s, s.mono, p.invoiceId!, 'success');
    expect((await post(webhookPath(s), success.raw, success.sign)).statusCode).toBe(200);
    expect((await post(webhookPath(s), processing.raw, processing.sign)).statusCode).toBe(200);
    await settle();
    expect(a!.paymentRepo.get(s.shopId, p.id)!.state).toBe('success');
    expect(a!.paymentRepo.listEvents(s.shopId, p.id).map((e) => [e.status, e.verdict])).toEqual([
      ['success', 'applied'],
      ['processing', 'stale'],
    ]);
    const reversed = pay(s, s.mono, p.invoiceId!, 'reversed');
    await post(webhookPath(s), reversed.raw, reversed.sign);
    await settle();
    expect(a!.paymentRepo.get(s.shopId, p.id)!.state).toBe('reversed');
    expect(a!.orders.getDraft(s.shopId, id)!.draft.status).toBe('shipped');
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update').map((n) => (n as { event: string }).event)).toEqual(['paid', 'payment_reversed']);
  });

  it('an amount or currency mismatch escalates instead of marking paid', async () => {
    const s = await setup(orderScript());
    const { id, pay: p } = await approvedPrepaid(s);
    const w = pay(s, s.mono, p.invoiceId!, 'success', { amount: 100 });
    expect((await post(webhookPath(s), w.raw, w.sign)).statusCode).toBe(200);
    const usd = pay(s, s.mono, p.invoiceId!, 'success', { ccy: 840 });
    await post(webhookPath(s), usd.raw, usd.sign);
    await settle();
    expect(a!.orders.getDraft(s.shopId, id)!.draft.status).toBe('awaiting_payment');
    expect(a!.paymentRepo.get(s.shopId, p.id)).toMatchObject({ state: 'created', flag: 'AMOUNT_MISMATCH' });
    expect(a!.agentRepo.openEscalation(s.shopId, draft(s).conversationId)?.reason).toMatch(/не збігається/);
    expect(ttnSaves(s)).toHaveLength(0);
  });

  it('a failed payment tells the shop and frees the slot for a new link', async () => {
    const s = await setup(orderScript());
    const { id, pay: p } = await approvedPrepaid(s);
    const w = pay(s, s.mono, p.invoiceId!, 'failure', { errCode: '59' });
    await post(webhookPath(s), w.raw, w.sign);
    await settle();
    expect(a!.paymentRepo.get(s.shopId, p.id)).toMatchObject({ state: 'failure', active: false, providerErrCode: '59' });
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update')).toMatchObject([{ event: 'payment_failed' }]);
    const r = await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/payment-link`, {});
    expect(r.body.payment.latest.paymentId).not.toBe(p.id);
    expect(systemMessages(s)).toHaveLength(2);
  });
});

describe('"I paid" and the reply guard', () => {
  it('a customer saying they paid changes nothing; a model claiming payment is blocked and the chat goes to a person', async () => {
    const s = await setup([
      ...orderScript(),
      say('Оплату отримано, дякуємо!'),
      useTool('get_order_status', {}),
      (req) => (expect(lastToolResult(req).orders[0]).toMatchObject({ status: 'awaiting_payment', payment: { paid: false, paymentLink: expect.stringMatching(/^https:\/\/pay\.mbnk\.biz\//) } }), say('Оплата надійшла!')),
    ]);
    const { id } = await approvedPrepaid(s);
    await customerWrites(s, 'Я вже оплатив!');
    expect(a!.orders.getDraft(s.shopId, id)!.draft.status).toBe('awaiting_payment');
    expect(a!.agentRepo.listRuns(s.shopId).items[0]).toMatchObject({ status: 'escalated', detail: 'GUARD_BLOCKED' });
    const replies = a!.conversations.listMessages(s.shopId, draft(s).conversationId, { limit: 50 }).items.filter((m) => m.senderType === 'ai').map((m) => m.text);
    expect(replies.join('\n')).not.toMatch(/Оплату отримано|Оплата надійшла/);
  });

  it('a payment link the model writes itself is blocked', async () => {
    const s = await setup([...orderScript(), say('Ось посилання: https://pay.mbnk.biz/fake123'), say('Посилання: https://pay.mbnk.biz/fake456')]);
    await approvedPrepaid(s);
    await customerWrites(s, 'Скиньте посилання');
    expect(a!.agentRepo.listRuns(s.shopId).items[0]).toMatchObject({ status: 'escalated', detail: 'GUARD_BLOCKED' });
  });

  it('get_order_status returns the real link and the paid state; the model may then say so', async () => {
    const s = await setup([...orderScript(), useTool('get_order_status', {}), (req) => say(`Посилання на оплату: ${lastToolResult(req).orders[0].payment.paymentLink}`), useTool('get_order_status', {}), say('Так, замовлення оплачено.')]);
    const { pay: p } = await approvedPrepaid(s);
    await customerWrites(s, 'Скиньте посилання ще раз');
    expect(a!.agentRepo.listRuns(s.shopId).items[0]!.status).toBe('replied');
    const w = pay(s, s.mono, p.invoiceId!);
    await post(webhookPath(s), w.raw, w.sign);
    await settle();
    await customerWrites(s, 'Оплата пройшла?');
    expect(a!.agentRepo.listRuns(s.shopId).items[0]!.status).toBe('replied');
  });
});

describe('reconciliation, deadline and reminder', () => {
  it('a lost webhook: the status call finds the payment', async () => {
    const s = await setup(orderScript());
    const { pay: p } = await approvedPrepaid(s);
    s.mono.setStatus(p.invoiceId!, 'success');
    expect((await a!.payments.reconcileOnce()).checked).toBe(0); // too fresh: the webhook normally comes first
    sql('update order_payments set created_at = ? where id = ?', new Date(Date.now() - 10 * 60_000).toISOString(), p.id);
    expect((await a!.payments.reconcileOnce()).checked).toBe(1);
    await settle();
    expect(draft(s).status).toBe('shipped');
    expect(a!.paymentRepo.listEvents(s.shopId, p.id).map((e) => e.source)).toEqual(['status']);
  });

  it('one reminder before the deadline; at the deadline the invoice is removed and the order cancelled with restock; a late payment escalates', async () => {
    const s = await setup(orderScript());
    const { id, pay: p } = await approvedPrepaid(s);
    expect(stock(s)).toBe(1);
    sql('update order_drafts set payment_due_at = ? where id = ?', new Date(Date.now() + 5 * 3600_000).toISOString(), id);
    expect((await a!.payments.reconcileOnce()).reminded).toBe(1);
    expect((await a!.payments.reconcileOnce()).reminded).toBe(0);
    const msgs = systemMessages(s);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.text).toMatch(/^Нагадуємо: замовлення .* ще не оплачене/);

    sql('update order_drafts set payment_due_at = ? where id = ?', new Date(Date.now() - 60_000).toISOString(), id);
    expect((await a!.payments.reconcileOnce()).expired).toBe(1);
    expect(draft(s).status).toBe('cancelled');
    expect(stock(s)).toBe(3);
    expect(a!.orders.listEvents(s.shopId, id).at(-1)).toMatchObject({ fromStatus: 'awaiting_payment', toStatus: 'cancelled', actor: 'system:timeout' });
    expect(s.mono.only('/api/merchant/invoice/remove')).toHaveLength(1);
    expect(a!.paymentRepo.get(s.shopId, p.id)!.state).toBe('removed');
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update').map((n) => (n as { event: string }).event)).toEqual(['payment_expired']);

    const late = pay(s, s.mono, p.invoiceId!);
    await post(webhookPath(s), late.raw, late.sign);
    await settle();
    expect(draft(s).status).toBe('cancelled');
    expect(stock(s)).toBe(3);
    expect(a!.paymentRepo.get(s.shopId, p.id)!.flag).toBe('PAID_AFTER_CANCEL');
    expect(a!.agentRepo.openEscalation(s.shopId, draft(s).conversationId)?.reason).toMatch(/скасоване замовлення/);
  });

  it('a payment still processing at the deadline gets a grace period instead of a cancel', async () => {
    const s = await setup(orderScript());
    const { id, pay: p } = await approvedPrepaid(s);
    s.mono.setStatus(p.invoiceId!, 'processing');
    sql('update order_drafts set payment_due_at = ? where id = ?', new Date(Date.now() - 60_000).toISOString(), id);
    expect((await a!.payments.reconcileOnce()).expired).toBe(0);
    expect(draft(s).status).toBe('awaiting_payment');
    s.mono.setStatus(p.invoiceId!, 'success');
    await a!.payments.reconcileOnce();
    await settle();
    expect(draft(s).status).toBe('shipped');
  });

  it('a member cancelling an unpaid order deactivates its invoice', async () => {
    const s = await setup(orderScript());
    const { id, pay: p } = await approvedPrepaid(s);
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/cancel`, {})).body.status).toBe('cancelled');
    await settle();
    expect(s.mono.only('/api/merchant/invoice/remove')[0]!.body).toEqual({ invoiceId: p.invoiceId });
    expect(a!.paymentRepo.get(s.shopId, p.id)!.state).toBe('removed');
  });
});

describe('refund requests', () => {
  it('only after payment, by a member, with a notice to the shop', async () => {
    const s = await setup(orderScript());
    const { id, pay: p } = await approvedPrepaid(s);
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/refund-requested`, {})).status).toBe(400);
    const w = pay(s, s.mono, p.invoiceId!);
    await post(webhookPath(s), w.raw, w.sign);
    await settle();
    const r = await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/refund-requested`, { note: 'розмір не підійшов' });
    expect(r.body.status).toBe('refund_requested');
    expect(a!.orders.listEvents(s.shopId, id).at(-1)).toMatchObject({ toStatus: 'refund_requested', actor: expect.stringMatching(/^user:/) });
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update').at(-1)).toMatchObject({ event: 'refund_requested' });
    const list = await call(a!, s.token, 'GET', `${s.base}/order-drafts/${id}/payments`);
    expect(list.body.items).toMatchObject([{ state: 'success', events: [{ status: 'success', source: 'webhook', verdict: 'applied' }] }]);
  });
});
