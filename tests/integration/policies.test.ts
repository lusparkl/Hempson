import { afterEach, describe, expect, it } from 'vitest';
import { call, makeApp, mockAccount, type TestApp } from '../helpers';
import { ScriptedLlm, lastToolResult, say, useTool } from '../fixtures/scripted-llm';

const PW = 'correct horse battery';
const THREAD = 'mock-thread-olena';
const RETURNS = 'Повернення або обмін протягом 14 днів з моменту отримання, якщо товар не був у використанні. Доставку повернення оплачує покупець.';
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

async function setup(llm = new ScriptedLlm([])) {
  a = await makeApp({ llm });
  const token = await login('o@example.com');
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
  const acc = await mockAccount(a);
  await a.svc.syncOnce(acc);
  await call(a, a.admin, 'PUT', `/v1/accounts/${acc}/shop`, { shopId });
  await call(a, a.admin, 'PATCH', `/v1/accounts/${acc}/settings`, { outboundEnabled: true });
  await call(a, token, 'PUT', `/v1/shops/${shopId}/ai`, { enabled: true });
  return { token, shopId, acc, llm };
}
type S = Awaited<ReturnType<typeof setup>>;
const customerWrites = async (s: S, text: string) => {
  a!.mock.devInjectIncoming(s.acc, THREAD, text);
  await a!.svc.syncOnce(s.acc);
  await a!.salesAgent!.whenIdle();
};
const aiMsgs = (s: S) => {
  const c = a!.conversations.listConversations(s.shopId).items.find((x) => x.conversation.externalId === THREAD)!;
  return a!.conversations.listMessages(s.shopId, c.conversation.id, { limit: 200 }).items.filter((m) => m.senderType === 'ai');
};
const lastRun = (s: S) => a!.agentRepo.listRuns(s.shopId).items[0]!;

describe('policy routes', () => {
  it('owner edits with versions; a manager only reads; outsiders and other shops see nothing', async () => {
    const s = await setup();
    const base = `/v1/shops/${s.shopId}/policies`;
    expect((await call(a!, s.token, 'GET', base)).body.items.map((p: any) => [p.topic, p.text, p.version])).toEqual([
      ['delivery', '', 0],
      ['returns', '', 0],
      ['payment', '', 0],
      ['hours', '', 0],
    ]);
    expect((await call(a!, s.token, 'PUT', `${base}/returns`, { text: RETURNS })).body).toMatchObject({ topic: 'returns', version: 1 });
    expect((await call(a!, s.token, 'PUT', `${base}/returns`, { text: ` ${RETURNS} ` })).body).toMatchObject({ text: RETURNS, version: 2 });
    expect((await call(a!, s.token, 'PUT', `${base}/warranty`, { text: 'x' })).status).toBe(400);
    expect((await call(a!, s.token, 'PUT', `${base}/returns`, { text: 'x'.repeat(4001) })).status).toBe(400);

    const mgr = await login('m@example.com');
    expect((await call(a!, mgr, 'GET', base)).status).toBe(404);
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a!, mgr, 'GET', base)).body.items[1]).toMatchObject({ topic: 'returns', text: RETURNS });
    expect((await call(a!, mgr, 'PUT', `${base}/returns`, { text: 'інше' })).status).toBe(403);
    expect((await call(a!, a!.admin, 'GET', base)).status).toBe(401);

    const t2 = await login('o2@example.com');
    const shop2 = (await call(a!, t2, 'POST', '/v1/shops', { name: 'Інший', slug: 'shop-two' })).body.shopId as string;
    expect((await call(a!, t2, 'GET', `/v1/shops/${shop2}/policies`)).body.items.every((p: any) => p.text === '')).toBe(true);
    expect((await call(a!, t2, 'PUT', `${base}/returns`, { text: 'hack' })).status).toBe(404);
    expect(a!.policies.get(s.shopId, 'returns')!.text).toBe(RETURNS);
  });
});

describe('agent and policies', () => {
  it('quotes the stored policy: get_policy returns text and version, the reply is sent', async () => {
    const llm = new ScriptedLlm([
      useTool('get_policy', { topic: 'returns' }),
      (req) => {
        expect(lastToolResult(req)).toEqual({ topic: 'returns', available: true, version: 1, text: RETURNS });
        return say('Повернути або обміняти товар можна протягом 14 днів, якщо він не був у використанні.');
      },
    ]);
    const s = await setup(llm);
    await call(a!, s.token, 'PUT', `/v1/shops/${s.shopId}/policies/returns`, { text: RETURNS });
    await customerWrites(s, 'Чи можна повернути товар?');
    expect(lastRun(s)).toMatchObject({ status: 'replied' });
    expect(aiMsgs(s)).toHaveLength(1);
  });

  it('a return period not in the policy text is blocked and the conversation escalates', async () => {
    const llm = new ScriptedLlm([useTool('get_policy', { topic: 'returns' }), say('Повернення протягом 30 днів.'), say('Можна повернути протягом 30 днів, без проблем.')]);
    const s = await setup(llm);
    await call(a!, s.token, 'PUT', `/v1/shops/${s.shopId}/policies/returns`, { text: RETURNS });
    await customerWrites(s, 'Скільки днів на повернення?');
    expect(llm.calls[2]!.messages.at(-1)!.content).toContain('period 30 is not in the shop policy');
    expect(lastRun(s)).toMatchObject({ status: 'escalated', detail: 'GUARD_BLOCKED' });
    expect(aiMsgs(s)).toHaveLength(0);
    expect(a!.agentRepo.openEscalation(s.shopId, lastRun(s).conversationId)).toBeTruthy();
  });

  it('a delivery time stated without get_policy is blocked even when it sounds plausible', async () => {
    const llm = new ScriptedLlm([say('Доставка займе 1-2 дні.'), say('Відправимо за 1-2 дні.')]);
    const s = await setup(llm);
    await customerWrites(s, 'Коли доставите?');
    expect(lastRun(s)).toMatchObject({ status: 'escalated', detail: 'GUARD_BLOCKED' });
    expect(aiMsgs(s)).toHaveLength(0);
  });

  it('a shop with no policy text gets an escalation instead of an invented answer', async () => {
    const llm = new ScriptedLlm([
      useTool('get_policy', { topic: 'returns' }),
      (req) => (expect(lastToolResult(req)).toMatchObject({ available: false, instruction: expect.stringContaining('escalate') }), useTool('escalate', { reason: 'Питання про повернення, політики немає' })),
      say('Щодо повернення вам відповість менеджер.'),
    ]);
    const s = await setup(llm);
    await customerWrites(s, 'Як повернути товар?');
    expect(lastRun(s)).toMatchObject({ status: 'escalated' });
    expect(aiMsgs(s)).toMatchObject([{ text: 'Щодо повернення вам відповість менеджер.' }]);
  });

  it('a model that ignores the missing policy and answers anyway is blocked', async () => {
    const llm = new ScriptedLlm([useTool('get_policy', { topic: 'returns' }), say('Повернення можливе.'), say('Так, повернення можливе.')]);
    const s = await setup(llm);
    await customerWrites(s, 'Можна повернути?');
    expect(llm.calls[2]!.messages.at(-1)!.content).toContain('no returns policy text');
    expect(lastRun(s)).toMatchObject({ status: 'escalated', detail: 'GUARD_BLOCKED' });
    expect(aiMsgs(s)).toHaveLength(0);
  });

  it('policy text is shop-scoped: the tool never returns another shop’s text', async () => {
    const llm = new ScriptedLlm([useTool('get_policy', { topic: 'returns' }), (req) => (expect(lastToolResult(req).available).toBe(false), useTool('escalate', { reason: 'немає політики' })), say('Передам менеджеру.')]);
    const s = await setup(llm);
    const other = a!.shops.create({ name: 'Other', slug: 'other-shop' }).id;
    a!.policies.save(other, 'returns', RETURNS, null);
    await customerWrites(s, 'Повернення?');
    expect(lastRun(s).status).toBe('escalated');
  });
});
