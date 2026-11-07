import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Keyring } from '@hepson/database';
import { makeApp, call, type TestApp } from '../helpers';
import { LlmError } from '../../apps/api/src/agent/llm';
import type { Notification, Notifier } from '../../apps/api/src/services/notifier';
import { ScriptedLlm, lastToolResult, say, useTool } from '../fixtures/scripted-llm';
import { NP, NP_KEY, fakeNovaPoshta, npLookups, npOrder } from '../fixtures/fake-nova-poshta';

const PW = 'correct horse battery';
let a: TestApp | undefined;
afterEach(async () => {
  await a?.close();
  a?.cleanup();
  a = undefined;
});

/** Shop with a catalog and Nova Poshta; the AI stays OFF unless asked (the playground must work before it is switched on). */
async function setup(llm: ScriptedLlm | null) {
  const sent: Notification[] = [];
  const notifier: Notifier = { notify: (n) => void sent.push(n), whenIdle: async () => {} };
  a = await makeApp({ ...(llm ? { llm } : {}), notifier, keyring: new Keyring(1, randomBytes(32)), fetchImpl: fakeNovaPoshta().fetchFor() });
  await call(a, null, 'POST', '/v1/auth/register', { email: 'o@example.com', displayName: 'O', password: PW });
  const token = (await call(a, null, 'POST', '/v1/auth/login', { email: 'o@example.com', password: PW })).body.token as string;
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
  a.catalog.createProduct(shopId, {
    name: 'Худі Classic',
    description: 'Бавовна',
    priceMinor: 129_900,
    currency: 'UAH',
    variants: [{ sku: 'HOODIE-M', options: { size: 'M' }, stock: 3 }],
  });
  await call(a, token, 'PUT', `/v1/shops/${shopId}/ai`, { instructions: 'Звертайся на "ви".' });
  await call(a, token, 'PUT', `/v1/shops/${shopId}/nova-poshta/key`, { apiKey: NP_KEY });
  await call(a, token, 'PUT', `/v1/shops/${shopId}/nova-poshta/settings`, {
    senderCityRef: NP.kyivRef,
    senderCityName: 'Київ',
    senderWarehouseRef: NP.branch12Ref,
    senderWarehouseName: 'Відділення №12',
  });
  const play = (body: unknown) => call(a!, token, 'POST', `/v1/shops/${shopId}/ai/playground`, body);
  return { token, shopId, play, sent };
}

/** Nothing a real run leaves behind: runs, conversations, drafts, escalations, reply-cap use. */
function expectNoTrace(shopId: string) {
  expect(a!.agentRepo.listRuns(shopId).items).toEqual([]);
  expect(a!.conversations.listConversations(shopId).items).toEqual([]);
  expect(a!.orders.listDrafts(shopId).items).toEqual([]);
  expect(a!.agentRepo.listEscalations(shopId).items).toEqual([]);
  expect(a!.plans.usage(shopId).aiReplies).toBe(0);
}

describe('AI playground', () => {
  it('answers from the catalog with the saved notes while the AI is off, and stores nothing', async () => {
    const llm = new ScriptedLlm([useTool('search_products', { query: 'худі' }), say('Худі Classic M коштує 1299 грн, є 3 шт.')]);
    const s = await setup(llm);
    const r = await s.play({ messages: [{ role: 'customer', text: 'Скільки худі?' }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'replied', reply: 'Худі Classic M коштує 1299 грн, є 3 шт.', escalation: null, blocked: [], usage: { modelRequests: 2 } });
    expect(r.body.tools).toMatchObject([{ name: 'search_products', arguments: '{"query":"худі"}' }]);
    expect(JSON.parse(r.body.tools[0].result).products[0].name).toBe('Худі Classic');
    expect(llm.calls[0]!.messages[0]!.content).toContain('Звертайся на "ви".');
    expect(llm.calls[0]!.tools.map((t) => t.name)).not.toContain('search_by_photo');
    expectNoTrace(s.shopId);
  });

  it('uses unsaved notes and the given history; the last customer messages may be echoed back', async () => {
    const llm = new ScriptedLlm([say('Добре, 7 штук записала.')]);
    const s = await setup(llm);
    const r = await s.play({
      instructions: 'Пиши дуже коротко.',
      messages: [
        { role: 'customer', text: 'Привіт' },
        { role: 'assistant', text: 'Вітаю! Чим допомогти?' },
        { role: 'customer', text: 'Хочу 7 штук' },
      ],
    });
    expect(r.body).toMatchObject({ outcome: 'replied', reply: 'Добре, 7 штук записала.' });
    const sys = llm.calls[0]!.messages[0]!.content as string;
    expect(sys).toContain('Пиши дуже коротко.');
    expect(sys).not.toContain('Звертайся на "ви".');
    expect(llm.calls[0]!.messages.slice(1)).toEqual([
      { role: 'user', content: 'Привіт' },
      { role: 'assistant', content: 'Вітаю! Чим допомогти?' },
      { role: 'user', content: 'Хочу 7 штук' },
    ]);
  });

  it('runs the reply guard: an invented price gets one repair, then the outcome is blocked', async () => {
    const llm = new ScriptedLlm([say('Худі коштує 500 грн'), say('Точно 500 грн')]);
    const s = await setup(llm);
    const r = await s.play({ messages: [{ role: 'customer', text: 'Скільки худі?' }] });
    expect(r.body).toMatchObject({ outcome: 'blocked', reply: null });
    expect(r.body.blocked.join(' ')).toContain('500.00');
    expectNoTrace(s.shopId);
  });

  it('checks an order like a real draft but creates nothing; escalate notifies nobody', async () => {
    const llm = new ScriptedLlm([
      npLookups(),
      useTool('create_order_draft', npOrder([{ sku: 'HOODIE-M', quantity: 9 }]), 'c_bad'),
      (req) => {
        expect(lastToolResult(req)).toMatchObject({ error: ['HOODIE-M: requested 9, only 3 in stock'] });
        return useTool('create_order_draft', npOrder([{ sku: 'HOODIE-M', quantity: 2 }]), 'c_ok');
      },
      (req) => {
        expect(lastToolResult(req)).toMatchObject({ draftId: null, status: 'pending_approval', confirmed: false, total: '2598.00 UAH' });
        return useTool('get_order_status', {});
      },
      (req) => {
        expect(lastToolResult(req)).toMatchObject({ orders: [] });
        return useTool('escalate', { reason: 'Клієнт просить знижку' });
      },
      say('Записала замовлення на 2598.00 грн, менеджер підтвердить і відповість щодо знижки.'),
    ]);
    const s = await setup(llm);
    const r = await s.play({ messages: [{ role: 'customer', text: 'Беру 2 худі M, Олена Коваль, 050 111 22 33, Київ НП 5, і дайте знижку' }] });
    expect(r.body).toMatchObject({ outcome: 'escalated', escalation: 'Клієнт просить знижку', reply: expect.stringContaining('2598.00') });
    expect(r.body.tools.map((t: { name: string }) => t.name)).toEqual([
      'find_np_city',
      'find_np_branch',
      'get_checkout_options',
      'create_order_draft',
      'create_order_draft',
      'get_order_status',
      'escalate',
    ]);
    expectNoTrace(s.shopId);
    expect(s.sent).toEqual([]);
    expect(a!.catalog.findVariantBySku(s.shopId, 'HOODIE-M')!.stock).toBe(3);
  });

  it('a silent escalation is reported without a reply', async () => {
    const llm = new ScriptedLlm([useTool('escalate', { reason: 'Скарга' }), say('')]);
    const s = await setup(llm);
    const r = await s.play({ messages: [{ role: 'customer', text: 'Жахливий сервіс' }] });
    expect(r.body).toMatchObject({ outcome: 'escalated', reply: null, escalation: 'Скарга' });
  });

  it('validates input, checks membership, maps model errors and limits turns per shop', async () => {
    const llm = new ScriptedLlm([new LlmError('OpenAI HTTP 500', true, 500)]);
    const s = await setup(llm);
    expect((await s.play({ messages: [] })).status).toBe(400);
    expect((await s.play({ messages: [{ role: 'assistant', text: 'Вітаю' }] })).body.error.message).toContain('last message must be from the customer');
    expect((await s.play({ messages: [{ role: 'customer', text: 'x' }], extra: 1 })).status).toBe(400);
    const e = await s.play({ messages: [{ role: 'customer', text: 'Привіт' }] });
    expect(e.status).toBe(503);
    expect(e.body.error.code).toBe('TEMPORARY_FAILURE');

    await call(a!, null, 'POST', '/v1/auth/register', { email: 'x@example.com', displayName: 'X', password: PW });
    const other = (await call(a!, null, 'POST', '/v1/auth/login', { email: 'x@example.com', password: PW })).body.token as string;
    expect((await call(a!, other, 'POST', `/v1/shops/${s.shopId}/ai/playground`, { messages: [{ role: 'customer', text: 'Привіт' }] })).status).toBe(404);

    for (let i = 0; i < 59; i++) llm.push(say('Вітаю!'));
    for (let i = 0; i < 59; i++) expect((await s.play({ messages: [{ role: 'customer', text: 'Привіт' }] })).status).toBe(200);
    const limited = await s.play({ messages: [{ role: 'customer', text: 'Привіт' }] });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
  });

  it('answers 503 NOT_CONFIGURED when the server has no model', async () => {
    const s = await setup(null);
    const r = await s.play({ messages: [{ role: 'customer', text: 'Привіт' }] });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('NOT_CONFIGURED');
  });
});
