import { afterEach, describe, expect, it } from 'vitest';
import { PlanRepository, WEB_CHANNEL, utcMonth } from '@hepson/database';
import { loadConfig } from '../../apps/api/src/config';
import { call, makeApp, type TestApp } from '../helpers';
import { ScriptedLlm, say } from '../fixtures/scripted-llm';
import type { Notification, Notifier } from '../../apps/api/src/services/notifier';

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
  const shopA = await newShop(token, 'shop-a');
  return { llm, notifier, token, shopA };
}
type S = Awaited<ReturnType<typeof setup>>;

async function newShop(token: string, slug: string) {
  const shopId = (await call(a!, token, 'POST', '/v1/shops', { name: 'Магазин', slug })).body.shopId as string;
  await call(a!, token, 'PUT', `/v1/shops/${shopId}/ai`, { enabled: true });
  return shopId;
}

let seq = 0;
/** A website visitor writes one message and the agent runs on it. Returns the conversation id. */
async function visitorWrites(shopId: string, text = 'Привіт', session = `web-${++seq}`) {
  const r = a!.conversations.ingestMessage(shopId, {
    channel: WEB_CHANNEL,
    conversationExternalId: session,
    customer: { externalId: session },
    externalId: `in-${++seq}`,
    text,
    attachments: [],
  });
  a!.salesAgent!.trigger(shopId, r.conversation.id, r.message.id);
  await a!.salesAgent!.whenIdle();
  return r.conversation.id;
}
/** The same visitor writes again in an existing website conversation. */
async function writeAgain(shopId: string, conversationId: string, text: string) {
  const session = a!.conversations.getConversation(shopId, conversationId)!.conversation.externalId;
  const r = a!.conversations.ingestMessage(shopId, {
    channel: WEB_CHANNEL,
    conversationExternalId: session,
    customer: { externalId: session },
    externalId: `in-${++seq}`,
    text,
    attachments: [],
  });
  a!.salesAgent!.trigger(shopId, conversationId, r.message.id);
  await a!.salesAgent!.whenIdle();
}
const setPlan = (shopId: string, body: unknown) => call(a!, a!.admin, 'PUT', `/v1/shops/${shopId}/plan`, body);
const runs = (shopId: string) => a!.agentRepo.listRuns(shopId, { limit: 100 }).items;
const quotaNotices = (s: S) => s.notifier.sent.filter((n) => n.kind === 'ai_quota');

describe('AI-reply cap', () => {
  it('replies up to the cap; at the cap no model call, the chat goes to a person with one holding text, the owner is told once', async () => {
    const s = await setup();
    expect((await setPlan(s.shopA, { plan: 'trial', customCap: 2 })).body).toMatchObject({ plan: 'trial', aiReplyCap: 2, aiReplies: 0, remaining: 2, capReached: false });
    s.llm.push(say('Вітаю!'), say('Так, є.'));
    await visitorWrites(s.shopA);
    await visitorWrites(s.shopA);
    expect(s.llm.calls).toHaveLength(2);
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopA}/usage`)).body).toMatchObject({ aiReplies: 2, aiReplyCap: 2, remaining: 0, capReached: true });

    const c3 = await visitorWrites(s.shopA, 'Є розмір M?');
    const c4 = await visitorWrites(s.shopA, 'А доставка?');
    expect(s.llm.calls).toHaveLength(2); // no model call at the cap
    expect(runs(s.shopA).filter((r) => r.detail === 'AI_REPLY_CAP')).toHaveLength(2);
    expect(runs(s.shopA).find((r) => r.detail === 'AI_REPLY_CAP')).toMatchObject({ status: 'escalated', modelRequests: 0, inputTokens: 0 });
    for (const c of [c3, c4]) {
      expect(a!.agentRepo.openEscalation(s.shopA, c)).toBeTruthy();
      const out = a!.conversations.listMessages(s.shopA, c, { limit: 10 }).items.filter((m) => m.direction === 'outgoing');
      expect(out).toMatchObject([{ senderType: 'system', text: 'Дякуємо за повідомлення! Менеджер відповість вам найближчим часом.', deliveryStatus: 'sent' }]);
    }
    expect(quotaNotices(s)).toEqual([{ kind: 'ai_quota', shopId: s.shopA, month: utcMonth(new Date()).month, cap: 2 }]);
    expect(s.notifier.sent.filter((n) => n.kind === 'escalation')).toHaveLength(0); // one notice, not one per chat

    // The customer writes again in the escalated chat: the run is skipped, no second holding text, no second notice.
    await writeAgain(s.shopA, c3, 'Ще раз');
    expect(runs(s.shopA)[0]).toMatchObject({ status: 'skipped', detail: 'ESCALATION_OPEN' });
    expect(a!.conversations.listMessages(s.shopA, c3, { limit: 10 }).items.filter((m) => m.senderType === 'system')).toHaveLength(1);
    expect(quotaNotices(s)).toHaveLength(1);

    const stats = (await call(a!, s.token, 'GET', `/v1/shops/${s.shopA}/stats`)).body;
    expect(stats.usage).toMatchObject({ aiReplies: 2, aiReplyCap: 2, capReached: true });
  });

  it('raising the cap lets the AI answer again; unlimited has no cap', async () => {
    const s = await setup();
    await setPlan(s.shopA, { plan: 'trial', customCap: 0 });
    await visitorWrites(s.shopA);
    expect(s.llm.calls).toHaveLength(0);
    await setPlan(s.shopA, { plan: 'unlimited' });
    s.llm.push(say('Вітаю!'));
    await visitorWrites(s.shopA);
    expect(s.llm.calls).toHaveLength(1);
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopA}/usage`)).body).toMatchObject({
      plan: 'unlimited',
      aiReplyCap: null,
      remaining: null,
      capReached: false,
      aiReplies: 1,
    });
  });

  it('runs that sent no reply do not count; a reply that may have gone out does', async () => {
    const s = await setup();
    await setPlan(s.shopA, { plan: 'trial', customCap: 5 });
    s.llm.push(new Error('boom'), say('Вітаю!'));
    await visitorWrites(s.shopA); // failed run
    await visitorWrites(s.shopA); // replied
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopA}/usage`)).body.aiReplies).toBe(1);
    a!.handle.raw.prepare("update ai_runs set status = 'send_uncertain' where status = 'replied'").run();
    expect(a!.plans.usage(s.shopA).aiReplies).toBe(1);
  });
});

describe('month rollover (UTC)', () => {
  it('counts only runs inside the UTC calendar month, boundaries exact', async () => {
    const s = await setup();
    s.llm.push(say('1'), say('2'), say('3'));
    for (let i = 0; i < 3; i++) await visitorWrites(s.shopA);
    const ids = runs(s.shopA).map((r) => r.id);
    const at = (id: string, iso: string) => a!.handle.raw.prepare('update ai_runs set created_at = ? where id = ?').run(iso, id);
    at(ids[0]!, '2026-10-31T23:59:59.999Z');
    at(ids[1]!, '2026-11-01T00:00:00.000Z');
    at(ids[2]!, '2026-11-30T23:59:59.999Z');
    const nov = new PlanRepository(a!.handle, 'starter', () => new Date('2026-11-15T12:00:00Z'));
    expect(nov.usage(s.shopA)).toMatchObject({ month: '2026-11', periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-12-01T00:00:00.000Z', aiReplies: 2 });
    expect(new PlanRepository(a!.handle, 'starter', () => new Date('2026-10-31T23:59:59.999Z')).usage(s.shopA)).toMatchObject({ month: '2026-10', aiReplies: 1 });
    expect(new PlanRepository(a!.handle, 'starter', () => new Date('2026-12-01T00:00:00.000Z')).usage(s.shopA)).toMatchObject({ month: '2026-12', aiReplies: 0 });
    // Kyiv is already in December at 23:30 UTC on 30 November; the quota month is still November.
    expect(new PlanRepository(a!.handle, 'starter', () => new Date('2026-11-30T23:30:00Z')).usage(s.shopA).month).toBe('2026-11');
  });

  it('a new month brings the AI back and allows one new owner notice', async () => {
    const s = await setup();
    await setPlan(s.shopA, { plan: 'trial', customCap: 1 });
    s.llm.push(say('Вітаю!'));
    await visitorWrites(s.shopA);
    await visitorWrites(s.shopA);
    expect(quotaNotices(s)).toHaveLength(1);
    // Everything so far happened "last month".
    const last = new Date(Date.parse(utcMonth(new Date()).start) - 1).toISOString();
    a!.handle.raw.prepare('update ai_runs set created_at = ?').run(last);
    a!.handle.raw.prepare('update shop_plans set cap_notice_month = ?').run(utcMonth(new Date(last)).month);
    s.llm.push(say('Знову тут'));
    await visitorWrites(s.shopA);
    expect(s.llm.calls).toHaveLength(2);
    await visitorWrites(s.shopA);
    expect(quotaNotices(s)).toHaveLength(2);
    expect(quotaNotices(s)[1]).toMatchObject({ month: utcMonth(new Date()).month });
    expect(a!.plans.claimCapNotice(s.shopA, utcMonth(new Date()).month)).toBe(false);
  });
});

describe('isolation and access', () => {
  it('one shop at its cap does not affect another; each counts only its own runs', async () => {
    const s = await setup();
    const shopB = await newShop(s.token, 'shop-b');
    await setPlan(s.shopA, { plan: 'trial', customCap: 1 });
    await setPlan(shopB, { plan: 'trial', customCap: 1 });
    s.llm.push(say('A1'));
    await visitorWrites(s.shopA);
    await visitorWrites(s.shopA); // A capped
    s.llm.push(say('B1'));
    await visitorWrites(shopB);
    expect(s.llm.calls).toHaveLength(2);
    expect(a!.plans.usage(s.shopA)).toMatchObject({ aiReplies: 1, capReached: true });
    expect(a!.plans.usage(shopB)).toMatchObject({ aiReplies: 1, capReached: true });
    expect(quotaNotices(s).map((n) => n.shopId)).toEqual([s.shopA]);
  });

  it('only the operator assigns plans; members read usage; others see nothing', async () => {
    const s = await setup();
    expect((await call(a!, s.token, 'GET', `/v1/shops/${s.shopA}/usage`)).body).toMatchObject({ plan: 'starter', aiReplyCap: 1000 });
    expect((await call(a!, s.token, 'PUT', `/v1/shops/${s.shopA}/plan`, { plan: 'unlimited' })).status).toBe(401);
    expect((await setPlan(s.shopA, { plan: 'gold' })).status).toBe(400);
    expect((await setPlan(s.shopA, { plan: 'growth', customCap: -1 })).status).toBe(400);
    expect((await setPlan('00000000-0000-4000-8000-000000000000', { plan: 'growth' })).status).toBe(404);
    expect((await setPlan(s.shopA, { plan: 'growth', customCap: 50 })).body).toMatchObject({ plan: 'growth', aiReplyCap: 50 });
    expect((await setPlan(s.shopA, { plan: 'growth' })).body).toMatchObject({ aiReplyCap: 3000 });

    const mgr = await login('m@example.com');
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopA}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a!, mgr, 'GET', `/v1/shops/${s.shopA}/usage`)).status).toBe(200);
    expect((await call(a!, await login('x@example.com'), 'GET', `/v1/shops/${s.shopA}/usage`)).status).toBe(404);
  });

  it('the default plan comes from HEPSON_DEFAULT_PLAN and must be a known plan', () => {
    expect(loadConfig({}).defaultPlan).toBe('starter');
    expect(loadConfig({ HEPSON_DEFAULT_PLAN: 'trial' }).defaultPlan).toBe('trial');
    expect(() => loadConfig({ HEPSON_DEFAULT_PLAN: 'gold' })).toThrow(/HEPSON_DEFAULT_PLAN/);
  });
});
