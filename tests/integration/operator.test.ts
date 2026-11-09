import { afterEach, describe, expect, it } from 'vitest';
import { LlmError } from '../../apps/api/src/agent/llm';
import { TOOLS } from '../../apps/api/src/agent/tools';
import { call, customerWrites, makeApp, type TestApp } from '../helpers';
import { ScriptedLlm, say, useTool } from '../fixtures/scripted-llm';
import { renderNotification, type Notification, type Notifier } from '../../apps/api/src/services/notifier';

const PW = 'correct horse battery';
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

async function setup() {
  const llm = new ScriptedLlm([]);
  const notifier = new FakeNotifier();
  a = await makeApp({ llm, notifier });
  const token = await login('o@example.com');
  const shopA = await newShop(token, 'shop-a', 'Магазин А');
  return { llm, notifier, token, shopA };
}

async function newShop(token: string, slug: string, name: string) {
  const shopId = (await call(a!, token, 'POST', '/v1/shops', { name, slug })).body.shopId as string;
  await call(a!, token, 'PUT', `/v1/shops/${shopId}/ai`, { enabled: true });
  return shopId;
}

const stop = (shopId: string, body: unknown) => call(a!, a!.admin, 'PUT', `/v1/operator/shops/${shopId}/ai-stop`, body);
const operatorShop = async (shopId: string) => (await call(a!, a!.admin, 'GET', '/v1/operator/shops')).body.shops.find((s: { shopId: string }) => s.shopId === shopId);
const outgoingAi = async (shopId: string, conversationId: string) =>
  (await a!.conversations.listMessages(shopId, conversationId, { limit: 20 })).items.filter((m) => m.senderType === 'ai');

const ROUTES: Array<['GET' | 'PUT', string]> = [
  ['GET', '/v1/operator/shops'],
  ['GET', '/v1/operator/runs'],
  ['GET', '/v1/operator/errors'],
  ['PUT', '/v1/operator/shops/00000000-0000-4000-8000-000000000000/ai-stop'],
];

describe('operator panel access', () => {
  it('needs an operator key: no key and a member session are both refused', async () => {
    const s = await setup();
    for (const [method, url] of ROUTES) {
      const body = method === 'PUT' ? { stopped: true } : undefined;
      expect((await call(a!, null, method, url, body)).status).toBe(401);
      expect((await call(a!, s.token, method, url, body)).status).toBe(401);
    }
  });

  it('a revoked key stops working', async () => {
    await setup();
    const { key, row } = await a!.apiKeys.create('temp');
    expect((await call(a!, key, 'GET', '/v1/operator/shops')).status).toBe(200);
    await a!.apiKeys.revoke(row.id);
    expect((await call(a!, key, 'GET', '/v1/operator/shops')).status).toBe(401);
  });

  it('gives an operator key no access to the shop routes', async () => {
    const s = await setup();
    expect((await call(a!, a!.admin, 'GET', `/v1/shops/${s.shopA}/ai`)).status).toBe(401);
  });
});

describe('operator overview', () => {
  it('lists every shop with usage and channels, and runs across shops, without customer text', async () => {
    const s = await setup();
    const other = await login('b@example.com');
    const shopB = await newShop(other, 'shop-b', 'Магазин Б');
    s.llm.push(say('Вітаю!'), new LlmError('OpenAI HTTP 400', false, 400));
    await customerWrites(a!, s.shopA, 'w1', 'секретний текст клієнта');
    await customerWrites(a!, shopB, 'w2', 'секретний текст клієнта');

    const res = await call(a!, a!.admin, 'GET', '/v1/operator/shops');
    expect(res.status).toBe(200);
    expect(res.body.shops).toHaveLength(2);
    expect(await operatorShop(s.shopA)).toMatchObject({
      name: 'Магазин А',
      ownerEmail: 'o@example.com',
      aiEnabled: true,
      operatorStoppedAt: null,
      channels: { instagram: null, telegram: null, website: false },
      tokens: { input: 10, output: 5, modelRequests: 1 },
      last24h: { runs: 1, failedRuns: 0, failedSends: 0 },
      usage: { aiReplies: 1 },
    });
    expect(await operatorShop(shopB)).toMatchObject({ ownerEmail: 'b@example.com', last24h: { runs: 1, failedRuns: 1 }, usage: { aiReplies: 0 } });

    const runs = await call(a!, a!.admin, 'GET', '/v1/operator/runs');
    expect(runs.body.total).toBe(2);
    expect(runs.body.items[0]).toMatchObject({ shopName: 'Магазин Б', status: 'failed', detail: 'LLM_400' });
    const onlyA = await call(a!, a!.admin, 'GET', `/v1/operator/runs?shopId=${s.shopA}&status=replied`);
    expect(onlyA.body).toMatchObject({ total: 1, items: [{ shopId: s.shopA, status: 'replied' }] });
    expect(JSON.stringify([res.body, runs.body])).not.toContain('секретний');
  });

  it('reports failed runs and server errors even with Telegram alerts off', async () => {
    const s = await setup();
    s.llm.push(new LlmError('OpenAI HTTP 400 with customer text', false, 400));
    await customerWrites(a!, s.shopA, 'w1', 'Привіт');
    const r = (await call(a!, a!.admin, 'GET', '/v1/operator/errors')).body;
    expect(r).toMatchObject({
      alertsConfigured: false,
      incidents: [],
      events: [{ label: 'AI agent run failed', detail: 'LLM_400', count: 1 }],
      failedRuns: [{ detail: 'LLM_400' }],
    });
    expect(JSON.stringify(r)).not.toContain('customer text');
  });
});

describe('operator channel status', () => {
  const ig = (shopId: string, igUserId: string, username: string) => a!.igRepo.upsertChannel(shopId, { igUserId, username, tokenExpiresAt: '2027-01-09T00:00:00.000Z' });
  const tg = (shopId: string, botId: string, botUsername: string) => a!.tgRepo.upsertChannel(shopId, { botId, botUsername, webhookId: `hook-${botId}`, secret: `secret-${botId}` });

  it('shows connected channels with their accounts', async () => {
    const s = await setup();
    await ig(s.shopA, '1001', 'shop_a_ig');
    await tg(s.shopA, '2001', 'shop_a_bot');
    await a!.webChat.updateConfig(s.shopA, { enabled: true, allowedOrigins: ['https://shop-a.example'] });
    expect((await operatorShop(s.shopA)).channels).toEqual({
      instagram: { connected: true, status: 'connected', account: 'shop_a_ig', lastError: null, tokenExpiresAt: '2027-01-09T00:00:00.000Z' },
      telegram: { connected: true, status: 'connected', account: 'shop_a_bot', lastError: null },
      website: true,
    });
  });

  it('shows a channel that needs reconnecting with its code, shop by shop, and nothing usable from the channel row', async () => {
    const s = await setup();
    const shopB = await newShop(s.token, 'shop-b', 'Магазин Б');
    await ig(s.shopA, '1001', 'shop_a_ig');
    await tg(s.shopA, '2001', 'shop_a_bot');
    await ig(shopB, '1002', 'shop_b_ig');
    await tg(shopB, '2002', 'shop_b_bot');
    await a!.igRepo.setNeedsReconnect(s.shopA, 'TOKEN_REJECTED');
    await a!.tgRepo.setNeedsReconnect(shopB, 'BOT_TOKEN_REJECTED');

    const first = (await operatorShop(s.shopA)).channels;
    expect(first.instagram).toMatchObject({ connected: false, status: 'needs_reconnect', account: 'shop_a_ig', lastError: 'TOKEN_REJECTED' });
    expect(first.telegram).toMatchObject({ connected: true, lastError: null });
    const second = (await operatorShop(shopB)).channels;
    expect(second.instagram).toMatchObject({ connected: true, lastError: null });
    expect(second.telegram).toEqual({ connected: false, status: 'needs_reconnect', account: 'shop_b_bot', lastError: 'BOT_TOKEN_REJECTED' });

    const raw = JSON.stringify((await call(a!, a!.admin, 'GET', '/v1/operator/shops')).body);
    for (const hidden of ['secret-2001', 'hook-2001', 'webhookAuthHash']) expect(raw).not.toContain(hidden);
  });

  it('a website chat switched off does not count as a channel', async () => {
    const s = await setup();
    await a!.webChat.updateConfig(s.shopA, { enabled: false, allowedOrigins: [] });
    expect((await operatorShop(s.shopA)).channels.website).toBe(false);
  });

  it('counts failed and uncertain sends of the last 24 hours, per shop, and not sent ones', async () => {
    const s = await setup();
    const shopB = await newShop(s.token, 'shop-b', 'Магазин Б');
    s.llm.push(say('Вітаю!'));
    const c = await customerWrites(a!, s.shopA, 'w1', 'Привіт');
    for (const status of ['failed', 'uncertain', 'sent'] as const) {
      const { message } = await a!.conversations.recordOutbound(s.shopA, c, { senderType: 'system', text: status, deliveryStatus: 'pending' });
      await a!.conversations.setDeliveryStatus(s.shopA, message.id, status, status === 'sent' ? { externalId: 'out-1' } : {});
    }
    expect((await operatorShop(s.shopA)).last24h.failedSends).toBe(2);
    expect((await operatorShop(shopB)).last24h.failedSends).toBe(0);
  });
});

describe('per-shop kill switch', () => {
  it('stops the AI without a model call or a run, leaves other shops alone, and the owner cannot clear it', async () => {
    const s = await setup();
    const shopB = await newShop(s.token, 'shop-b', 'Магазин Б');
    expect((await stop(s.shopA, { stopped: true, reason: 'скарга' })).body).toMatchObject({ stopped: true, reason: 'скарга' });

    await call(a!, s.token, 'PUT', `/v1/shops/${s.shopA}/ai`, { enabled: true, instructions: 'нотатки' });
    const c = await customerWrites(a!, s.shopA, 'w1', 'Привіт');
    expect(s.llm.calls).toHaveLength(0);
    expect((await a!.agentRepo.listRuns(s.shopA)).total).toBe(0);
    expect(await outgoingAi(s.shopA, c)).toEqual([]);
    expect((await a!.conversations.listMessages(s.shopA, c, { limit: 20 })).items).toHaveLength(1); // the message itself is kept

    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopA}/ai`)).body).toMatchObject({ enabled: true, operatorStopped: true, instructions: 'нотатки' });
    const seen = (await call(a!, s.token, 'GET', `/v1/shops/${s.shopA}/ai`)).body;
    expect(seen).not.toHaveProperty('operatorStopReason');
    expect(await operatorShop(s.shopA)).toMatchObject({ operatorStopReason: 'скарга', aiEnabled: true });

    s.llm.push(say('Вітаю!'));
    await customerWrites(a!, shopB, 'w2', 'Привіт');
    expect(s.llm.calls).toHaveLength(1);
  });

  it('resuming brings the AI back with the owner settings untouched', async () => {
    const s = await setup();
    await call(a!, s.token, 'PUT', `/v1/shops/${s.shopA}/ai`, { instructions: 'нотатки' });
    await stop(s.shopA, { stopped: true, reason: 'тест' });
    expect((await stop(s.shopA, { stopped: false })).body).toEqual({ stopped: false, stoppedAt: null, reason: null });
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopA}/ai`)).body).toMatchObject({ enabled: true, operatorStopped: false, instructions: 'нотатки' });
    s.llm.push(say('Вітаю!'));
    const c = await customerWrites(a!, s.shopA, 'w1', 'Привіт');
    expect(await outgoingAi(s.shopA, c)).toHaveLength(1);
  });

  it('works on a shop that never had AI settings, keeping its AI off after a resume', async () => {
    const s = await setup();
    const shopId = (await call(a!, s.token, 'POST', '/v1/shops', { name: 'Новий', slug: 'shop-new' })).body.shopId as string;
    expect((await stop(shopId, { stopped: true })).status).toBe(200);
    await stop(shopId, { stopped: false });
    expect((await call(a!, s.token, 'GET', `/v1/shops/${shopId}/ai`)).body).toMatchObject({ enabled: false, operatorStopped: false });
  });

  it('drops the reply of a run in flight and keeps its token count', async () => {
    const s = await setup();
    s.llm.push(async () => {
      await stop(s.shopA, { stopped: true });
      return say('Вже не можна');
    });
    const c = await customerWrites(a!, s.shopA, 'w1', 'Привіт');
    expect(await outgoingAi(s.shopA, c)).toEqual([]);
    expect((await a!.agentRepo.listRuns(s.shopA)).items[0]).toMatchObject({ status: 'skipped', detail: 'OPERATOR_STOPPED', modelRequests: 1, inputTokens: 10 });
  });

  it('makes no further model call once stopped between steps', async () => {
    const s = await setup();
    s.llm.push(async () => {
      await stop(s.shopA, { stopped: true });
      return useTool(TOOLS[0]!.name, {});
    });
    await customerWrites(a!, s.shopA, 'w1', 'Привіт');
    expect(s.llm.calls).toHaveLength(1);
    expect((await a!.agentRepo.listRuns(s.shopA)).items[0]).toMatchObject({ status: 'skipped', detail: 'OPERATOR_STOPPED', modelRequests: 1 });
  });

  it('refuses the test chat while stopped', async () => {
    const s = await setup();
    await stop(s.shopA, { stopped: true });
    const r = await call(a!, s.token, 'POST', `/v1/shops/${s.shopA}/ai/playground`, { messages: [{ role: 'customer', text: 'Привіт' }] });
    expect(r.status).toBe(403);
    expect(s.llm.calls).toHaveLength(0);
  });

  it('answers 404 for an unknown shop and tells nobody', async () => {
    const s = await setup();
    expect((await stop('00000000-0000-4000-8000-000000000000', { stopped: true })).status).toBe(404);
    expect(s.notifier.sent).toEqual([]);
  });

  it('tells the owner once per stop and once per resume, and the customer nothing', async () => {
    const s = await setup();
    await stop(s.shopA, { stopped: false }); // not stopped: nothing changes, nobody is told
    expect(s.notifier.sent).toEqual([]);

    await stop(s.shopA, { stopped: true, reason: 'внутрішня причина' });
    await stop(s.shopA, { stopped: true, reason: 'ще раз' });
    expect(s.notifier.sent).toEqual([{ kind: 'ai_stopped', shopId: s.shopA }]);

    const c = await customerWrites(a!, s.shopA, 'w1', 'Привіт');
    expect((await a!.conversations.listMessages(s.shopA, c, { limit: 20 })).items.filter((m) => m.direction === 'outgoing')).toEqual([]);
    expect(s.notifier.sent).toHaveLength(1); // a customer message during the stop adds no notice or escalation
    expect(await a!.agentRepo.openEscalation(s.shopA, c)).toBeUndefined();

    await stop(s.shopA, { stopped: false });
    await stop(s.shopA, { stopped: false });
    expect(s.notifier.sent).toEqual([
      { kind: 'ai_stopped', shopId: s.shopA },
      { kind: 'ai_resumed', shopId: s.shopA },
    ]);
  });

  it('renders fixed owner texts in the shop language, without the reason', () => {
    const shopId = 'x';
    const uk = { shopName: 'Магазин', language: 'uk', customer: '?' };
    expect(renderNotification({ kind: 'ai_stopped', shopId }, uk)).toContain('Команда Hepson зупинила ШІ');
    expect(renderNotification({ kind: 'ai_resumed', shopId }, uk)).toContain('Команда Hepson відновила ШІ');
    expect(renderNotification({ kind: 'ai_stopped', shopId }, { ...uk, language: 'en' })).toContain('stopped your shop');
    expect(renderNotification({ kind: 'ai_resumed', shopId }, { ...uk, language: 'en' })).toContain('resumed your shop');
  });
});
