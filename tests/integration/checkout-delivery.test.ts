import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Keyring } from '@hepson/database';
import { call, makeApp, mockAccount, type TestApp } from '../helpers';
import { ScriptedLlm, lastToolResult, say, useTool, type Entry } from '../fixtures/scripted-llm';
import { NP, NP_KEY, fakeNovaPoshta, npLookups, npOrder, type FakeNp } from '../fixtures/fake-nova-poshta';
import type { Notification, Notifier } from '../../apps/api/src/services/notifier';

// Nova Poshta behaviour below is the fake in tests/fixtures/fake-nova-poshta.ts, written from NP's documentation.
const PW = 'correct horse battery';
const THREAD = 'mock-thread-olena';
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

async function setup(script: Entry[] = [], o: { connect?: boolean; sender?: boolean } = {}) {
  const np = fakeNovaPoshta();
  const llm = new ScriptedLlm(script);
  const notifier = new FakeNotifier();
  a = await makeApp({ llm, notifier, keyring: new Keyring(1, randomBytes(32)), fetchImpl: np.fetchFor() });
  const token = await login('o@example.com');
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
  a.catalog.createProduct(shopId, { name: 'Худі Classic', priceMinor: 129_900, currency: 'UAH', variants: [{ sku: 'HOODIE-M', options: { size: 'M' }, stock: 3 }] });
  const acc = await mockAccount(a);
  await a.svc.syncOnce(acc);
  await call(a, a.admin, 'PUT', `/v1/accounts/${acc}/shop`, { shopId });
  await call(a, a.admin, 'PATCH', `/v1/accounts/${acc}/settings`, { outboundEnabled: true });
  await call(a, token, 'PUT', `/v1/shops/${shopId}/ai`, { enabled: true });
  if (o.connect !== false) expect((await call(a, token, 'PUT', `/v1/shops/${shopId}/nova-poshta/key`, { apiKey: NP_KEY })).status).toBe(200);
  if (o.sender !== false && o.connect !== false)
    await call(a, token, 'PUT', `/v1/shops/${shopId}/nova-poshta/settings`, { senderCityRef: NP.kyivRef, senderCityName: 'Київ', senderWarehouseRef: NP.branch12Ref, senderWarehouseName: 'Відділення №12' });
  return { np, llm, notifier, token, shopId, acc, base: `/v1/shops/${shopId}` };
}
type S = Awaited<ReturnType<typeof setup>>;
const customerWrites = async (s: S, text: string, thread = THREAD) => {
  a!.mock.devInjectIncoming(s.acc, thread, text);
  await a!.svc.syncOnce(s.acc);
  await a!.salesAgent!.whenIdle();
  await a!.delivery.whenIdle();
};
const lastRun = (s: S) => a!.agentRepo.listRuns(s.shopId).items[0]!;
const draft = (s: S) => a!.orders.listDrafts(s.shopId).items[0]!.draft;
const stock = (s: S) => a!.catalog.findVariantBySku(s.shopId, 'HOODIE-M')!.stock;
const saves = (np: FakeNp) => np.calls.filter((c) => c.modelName === 'InternetDocument' && c.calledMethod === 'save');
const ORDER = npOrder([{ sku: 'HOODIE-M', quantity: 2 }]);
const orderScript = (): Entry[] => [npLookups(), useTool('create_order_draft', ORDER), say('Записала замовлення, магазин його підтвердить.')];

describe('Nova Poshta connection and settings', () => {
  it('owner connects the key (checked with NP, never returned); managers read only; bad keys are refused', async () => {
    const s = await setup([], { connect: false });
    const url = `${s.base}/nova-poshta`;
    expect((await call(a!, s.token, 'GET', url)).body).toMatchObject({ available: true, status: 'not_connected', senderReady: false, codEnabled: true, prepaidEnabled: false, refusalLimit: 1 });
    expect((await call(a!, s.token, 'PUT', `${url}/key`, { apiKey: 'not-a-key' })).status).toBe(400);
    expect((await call(a!, s.token, 'PUT', `${url}/key`, { apiKey: 'f'.repeat(32) })).status).toBe(400);
    expect(a!.vault.get(s.shopId, 'nova_poshta')).toBeUndefined();

    const ok = await call(a!, s.token, 'PUT', `${url}/key`, { apiKey: NP_KEY });
    expect(ok.body).toMatchObject({ status: 'connected', senderPhone: '+380671234567', senderReady: false });
    expect(JSON.stringify(ok.body)).not.toContain(NP_KEY);
    expect(JSON.stringify((await call(a!, s.token, 'GET', url)).body)).not.toContain(NP_KEY);

    const branches = await call(a!, s.token, 'GET', `${url}/branches?cityRef=${NP.kyivRef}&q=12`);
    expect(branches.body.items).toEqual([expect.objectContaining({ ref: NP.branch12Ref, number: '12' })]);
    const set = await call(a!, s.token, 'PUT', `${url}/settings`, { senderCityRef: NP.kyivRef, senderCityName: 'Київ', senderWarehouseRef: NP.branch12Ref, senderWarehouseName: '№12', refusalLimit: 2, parcelWeightKg: '0,5' });
    expect(set.body).toMatchObject({ senderReady: true, refusalLimit: 2, parcelWeightKg: '0.5' });
    expect((await call(a!, s.token, 'PUT', `${url}/settings`, { refusalLimit: 5 })).status).toBe(400);

    const mgr = await login('m@example.com');
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a!, mgr, 'GET', url)).status).toBe(200);
    expect((await call(a!, mgr, 'PUT', `${url}/key`, { apiKey: NP_KEY })).status).toBe(403);
    expect((await call(a!, mgr, 'PUT', `${url}/settings`, { codEnabled: false })).status).toBe(403);
    expect((await call(a!, await login('x@example.com'), 'GET', url)).status).toBe(404);

    expect((await call(a!, s.token, 'DELETE', `${url}/key`)).body.status).toBe('not_connected');
  });

  it('a key NP stops accepting marks the shop for reconnect and tells the owner once', async () => {
    const s = await setup();
    s.np.validKeys.clear();
    expect((await call(a!, s.token, 'GET', `${s.base}/nova-poshta/cities?q=Київ`)).status).toBe(400);
    expect((await call(a!, s.token, 'GET', `${s.base}/nova-poshta`)).body).toMatchObject({ status: 'needs_reconnect', lastError: 'KEY_REJECTED' });
    expect(s.notifier.sent).toEqual([{ kind: 'channel_issue', shopId: s.shopId, channel: 'nova_poshta', issue: 'needs_reconnect' }]);
    expect((await call(a!, s.token, 'GET', `${s.base}/nova-poshta/cities?q=Київ`)).status).toBe(503);
    expect(s.notifier.sent).toHaveLength(1);
  });
});

describe('checkout tools', () => {
  it('the agent resolves city and branch through NP; the draft stores NP refs and names, not model text', async () => {
    const s = await setup([
      npLookups(),
      (req) => {
        const results = req.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse((m as { content: string }).content));
        expect(results[0].cities[0]).toEqual({ cityRef: NP.kyivRef, name: 'Київ', area: 'Київська' });
        expect(results[1].branches).toEqual([{ branchRef: NP.branch5Ref, number: '5', name: expect.stringContaining('№5') }]);
        expect(results[2].paymentMethods).toEqual([{ method: 'cod', description: expect.any(String) }]);
        return useTool('create_order_draft', ORDER);
      },
      (req) => (expect(lastToolResult(req)).toMatchObject({ status: 'pending_approval', confirmed: false }), say('Записала, магазин підтвердить.')),
    ]);
    await customerWrites(s, 'Беру 2 худі M. Олена Коваль, 050 111 22 33, Київ, відділення 5, оплата при отриманні');
    expect(lastRun(s).status).toBe('replied');
    expect(draft(s)).toMatchObject({ recipientPhone: '+380501112233', npCityRef: NP.kyivRef, npCityName: 'Київ', npWarehouseRef: NP.branch5Ref, paymentMethod: 'cod' });
    expect(stock(s)).toBe(3);
  });

  it('refs that no lookup returned in this run are refused; a branch needs its city', async () => {
    const s = await setup([
      useTool('find_np_branch', { cityRef: NP.kyivRef, query: '5' }, 'b0'),
      useTool('create_order_draft', ORDER, 'd0'),
      useTool('find_np_city', { query: 'Львів' }, 'c1'),
      useTool('find_np_branch', { cityRef: NP.lvivRef, query: '1' }, 'b1'),
      useTool('create_order_draft', { ...ORDER, cityRef: NP.kyivRef, branchRef: NP.lvivBranchRef }, 'd1'),
      (req) => {
        const r = req.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse((m as { content: string }).content));
        expect(r[0].error).toMatch(/find_np_city/);
        expect(r[1].error).toMatch(/look them up first/);
        expect(r[4].error).toMatch(/look them up first/);
        return useTool('escalate', { reason: 'Не вдалося оформити' });
      },
      say('Передам менеджеру.'),
    ]);
    await customerWrites(s, 'Оформіть');
    expect(a!.orders.listDrafts(s.shopId).total).toBe(0);
  });

  it('a shop without Nova Poshta cannot get AI drafts: the lookup tells the model to escalate', async () => {
    const s = await setup([useTool('find_np_city', { query: 'Київ' }), (req) => (expect(lastToolResult(req).error).toMatch(/escalate/), useTool('escalate', { reason: 'НП не підключена' })), say('Передам менеджеру.')], { connect: false });
    await customerWrites(s, 'Хочу замовити, Київ');
    expect(lastRun(s).status).toBe('escalated');
  });
});

describe('approval, TTN and tracking', () => {
  it('approving a COD order creates exactly one TTN with NP data; retries are refused', async () => {
    const s = await setup(orderScript());
    await customerWrites(s, 'Беру');
    const id = draft(s).id;
    const r = await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
    expect(r.body).toMatchObject({ status: 'cod_confirmed', checkout: { missing: [] } });
    await a!.delivery.whenIdle();
    const d = draft(s);
    expect(d).toMatchObject({ status: 'shipped', ttnState: 'created', ttn: expect.stringMatching(/^2045\d{10}$/) });
    expect(saves(s.np)).toHaveLength(1);
    expect(saves(s.np)[0]!.props).toMatchObject({ Cost: '2598', RecipientsPhone: '380501112233', RecipientAddress: NP.branch5Ref, SenderAddress: NP.branch12Ref, BackwardDeliveryData: [{ RedeliveryString: '2598' }] });
    expect(stock(s)).toBe(1);
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/ttn`, {})).status).toBe(400);
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/cancel`, {})).status).toBe(400);
    expect(saves(s.np)).toHaveLength(1);
    const events = (await call(a!, s.token, 'GET', `${s.base}/order-drafts/${id}/events`)).body.items.map((e: any) => [e.to, e.actor.split(':')[0]]);
    expect(events).toEqual([['pending_approval', 'ai'], ['approved', 'user'], ['cod_confirmed', 'user'], ['shipped', 'provider']]);
  });

  it('two TTN requests at once create one parcel', async () => {
    const s = await setup(orderScript(), { sender: true });
    await customerWrites(s, 'Беру');
    const id = draft(s).id;
    a!.orders.approve(s.shopId, id, a!.auth.listMembers(s.shopId)[0]!.user.id);
    const both = await Promise.allSettled([a!.delivery.createTtn(s.shopId, id), a!.delivery.createTtn(s.shopId, id)]);
    expect(both.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(saves(s.np)).toHaveLength(1);
  });

  it('no answer from NP while creating the TTN: uncertain, never retried, the shop is told; release allows a retry', async () => {
    const s = await setup(orderScript());
    await customerWrites(s, 'Беру');
    const id = draft(s).id;
    const real = s.np.handlers.save!;
    s.np.handlers.save = (p, model) => (model === 'InternetDocument' ? Promise.reject(new TypeError('socket hang up')) : real(p, model));
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
    await a!.delivery.whenIdle();
    expect(draft(s)).toMatchObject({ status: 'cod_confirmed', ttnState: 'uncertain', ttn: null });
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update')).toMatchObject([{ event: 'ttn_uncertain', draftId: id }]);
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/ttn`, {})).status).toBe(400);
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/cancel`, {})).status).toBe(400);
    s.np.handlers.save = real;
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/ttn/release`, {})).body.delivery).toMatchObject({ ttnState: 'failed' });
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/ttn`, {})).body).toMatchObject({ status: 'shipped', delivery: { ttnState: 'created' } });
  });

  it('NP refuses the document: failed, retryable after fixing; nothing shipped meanwhile', async () => {
    const s = await setup(orderScript());
    await customerWrites(s, 'Беру');
    const id = draft(s).id;
    const real = s.np.handlers.save!;
    s.np.handlers.save = (p, model) => (model === 'InternetDocument' ? new Response(JSON.stringify({ success: false, data: [], errors: ['SenderAddress is invalid'], errorCodes: ['20000200112'] })) : real(p, model));
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
    await a!.delivery.whenIdle();
    expect(draft(s)).toMatchObject({ status: 'cod_confirmed', ttnState: 'failed', ttnError: 'NP_REJECTED_20000200112' });
    s.np.handlers.save = real;
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/ttn`, {})).body.status).toBe('shipped');
  });

  it('tracking: delivered; a refusal moves to returning (no restock), notifies, counts; returned restocks once', async () => {
    const s = await setup([...orderScript(), npLookups(), (req) => (expect(lastToolResult(req).paymentMethods).toEqual([]), useTool('escalate', { reason: 'Немає способів оплати' })), say('Передам менеджеру.')]);
    await customerWrites(s, 'Беру');
    const id = draft(s).id;
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
    await a!.delivery.whenIdle();
    const ttn = draft(s).ttn!;
    s.np.statuses.set(ttn, { code: '5', text: 'Відправлення прямує до міста Київ' });
    expect(await a!.delivery.pollOnce()).toEqual({ checked: 1, transitions: 0 });
    expect(draft(s)).toMatchObject({ status: 'shipped', npStatusText: 'Відправлення прямує до міста Київ' });

    s.np.statuses.set(ttn, { code: '103', text: 'Відмова одержувача' });
    expect(await a!.delivery.pollOnce()).toEqual({ checked: 1, transitions: 1 });
    expect(await a!.delivery.pollOnce()).toEqual({ checked: 0, transitions: 0 });
    expect(draft(s).status).toBe('returning');
    expect(stock(s)).toBe(1);
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update')).toMatchObject([{ event: 'returning', ttn }]);
    const customerId = draft(s).customerId;
    expect((await call(a!, s.token, 'GET', `${s.base}/customers/${customerId}/refusals`)).body).toMatchObject({ refusals: 1, codBlocked: true, limit: 1, phone: '+380501112233' });

    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/returned`, {})).body.status).toBe('returned');
    expect(stock(s)).toBe(3);
    expect((await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/returned`, {})).status).toBe(400);
    expect(stock(s)).toBe(3);

    // The same customer asks again: no COD is offered, and the agent escalates.
    await customerWrites(s, 'Хочу ще раз замовити');
    expect(lastRun(s).status).toBe('escalated');
  });

  it('at the refusal limit the server refuses a COD draft whatever the model says', async () => {
    const s = await setup([npLookups(), useTool('create_order_draft', ORDER), (req) => (expect(lastToolResult(req).error).toEqual(['checkout.paymentMethod: cash on delivery is not available for this customer']), useTool('escalate', { reason: 'COD недоступний' })), say('Передам менеджеру.')]);
    const conv = a!.conversations.listConversations(s.shopId).items.find((x) => x.conversation.externalId === THREAD)!;
    await call(a!, s.token, 'POST', `${s.base}/customers/${conv.customer.id}/refusals`, { note: 'відмова в минулому' });
    await customerWrites(s, 'Беру, накладений платіж');
    expect(a!.orders.listDrafts(s.shopId).total).toBe(0);
  });
});

describe('auto_confirm (D26) and order status', () => {
  it('owner switches to auto_confirm (audited, owner only); a valid AI order is confirmed and shipped without a person', async () => {
    const s = await setup([
      npLookups(),
      useTool('create_order_draft', ORDER),
      (req) => (expect(lastToolResult(req)).toMatchObject({ confirmed: true, status: 'cod_confirmed' }), say('Замовлення підтверджено, відправимо Новою Поштою.')),
    ]);
    const mgr = await login('m@example.com');
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a!, mgr, 'PUT', `${s.base}/ai`, { autonomy: 'auto_confirm' })).status).toBe(403);
    const set = await call(a!, s.token, 'PUT', `${s.base}/ai`, { autonomy: 'auto_confirm', autoConfirmMaxMinor: 500_000 });
    expect(set.body).toMatchObject({ autonomy: 'auto_confirm', autoConfirmMaxMinor: 500_000, autonomyChangedBy: expect.any(String), autonomyChangedAt: expect.any(String) });

    await customerWrites(s, 'Беру');
    expect(lastRun(s).status).toBe('replied');
    expect(draft(s)).toMatchObject({ status: 'shipped', decidedByUserId: null });
    expect(a!.orders.listEvents(s.shopId, draft(s).id).find((e) => e.toStatus === 'approved')!.actor).toBe('system:auto_confirm');
    expect(s.notifier.sent.filter((n) => n.kind === 'order_update')).toMatchObject([{ event: 'auto_confirmed' }]);
  });

  it('over the cap the order waits for a person', async () => {
    const s = await setup([npLookups(), useTool('create_order_draft', ORDER), (req) => (expect(lastToolResult(req)).toMatchObject({ confirmed: false, status: 'pending_approval' }), say('Магазин підтвердить замовлення.'))]);
    await call(a!, s.token, 'PUT', `${s.base}/ai`, { autonomy: 'auto_confirm', autoConfirmMaxMinor: 100_000 });
    await customerWrites(s, 'Беру');
    expect(draft(s).status).toBe('pending_approval');
    expect(stock(s)).toBe(3);
  });

  it('a delivery status reply must come from get_order_status; the TTN is quoted from it', async () => {
    const s = await setup(orderScript());
    await customerWrites(s, 'Беру');
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${draft(s).id}/approve`, {});
    await a!.delivery.whenIdle();
    const ttn = draft(s).ttn!;
    s.llm.push(say('Ваше замовлення вже відправлено!'), say('Посилка вже в дорозі.'));
    await customerWrites(s, 'Де моє замовлення?');
    expect(lastRun(s)).toMatchObject({ status: 'escalated', detail: 'GUARD_BLOCKED' });

    await a!.agentRepo.resolveEscalation(s.shopId, a!.agentRepo.listEscalations(s.shopId).items[0]!.id, null);
    s.llm.push(useTool('get_order_status', {}), (req) => {
      expect(lastToolResult(req).orders[0]).toMatchObject({ status: 'shipped', novaPoshta: { ttn } });
      return say(`Замовлення відправлено Новою Поштою, ТТН ${ttn}.`);
    });
    await customerWrites(s, 'То де посилка?');
    expect(lastRun(s).status).toBe('replied');
  });
});
