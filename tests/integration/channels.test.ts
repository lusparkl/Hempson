import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, call, mockAccount, type TestApp } from '../helpers';

let a: TestApp;
beforeEach(async () => {
  a = await makeApp();
});
afterEach(async () => {
  await a.close();
  a.cleanup();
});

const PW = 'correct horse battery';
async function signup(email: string) {
  await call(a, null, 'POST', '/v1/auth/register', { email, displayName: 'U', password: PW });
  return (await call(a, null, 'POST', '/v1/auth/login', { email, password: PW })).body.token as string;
}
async function shopFor(email: string, slug: string) {
  const token = await signup(email);
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: slug, slug })).body.shopId as string;
  return { token, shopId };
}
const msgs = (shopId: string) => {
  const list = a.conversations.listConversations(shopId, { limit: 200 }).items;
  return list.flatMap((c) => a.conversations.listMessages(shopId, c.conversation.id, { limit: 200 }).items.map((m) => ({ conv: c.conversation.externalId, ...m })));
};
const sendMsg = (acc: string, convId: string, text: string, key: string) =>
  call(a, a.admin, 'POST', `/v1/accounts/${acc}/conversations/${convId}/messages`, { text, idempotencyKey: key });

describe('account <-> shop link', () => {
  it('admin links an account; cached history is mirrored; members see the channel', async () => {
    const s = await shopFor('o@example.com', 'shop-one');
    const acc = await mockAccount(a);
    await a.svc.syncOnce(acc);
    const r = await call(a, a.admin, 'PUT', `/v1/accounts/${acc}/shop`, { shopId: s.shopId });
    expect(r.status).toBe(200);
    expect(r.body.mirroredMessages).toBeGreaterThan(0);

    const conversations = a.conversations.listConversations(s.shopId);
    expect(conversations.total).toBe(3);
    const olena = conversations.items.find((c) => c.conversation.externalId === 'mock-thread-olena')!;
    expect(olena.conversation.channel).toBe('mock');
    expect(olena.customer).toMatchObject({ displayName: 'Олена Коваль', externalId: 'mock-thread-olena' });

    const ch = await call(a, s.token, 'GET', `/v1/shops/${s.shopId}/channels`);
    expect(ch.body.items).toEqual([expect.objectContaining({ accountId: acc, connectorType: 'mock', channel: 'mock' })]);
    expect((await call(a, a.admin, 'GET', `/v1/accounts/${acc}/status`)).body.shopId).toBe(s.shopId);
  });

  it('linking is idempotent and does not duplicate messages', async () => {
    const s = await shopFor('o@example.com', 'shop-one');
    const acc = await mockAccount(a);
    await a.svc.syncOnce(acc);
    await call(a, a.admin, 'PUT', `/v1/accounts/${acc}/shop`, { shopId: s.shopId });
    const n = msgs(s.shopId).length;
    await call(a, a.admin, 'PUT', `/v1/accounts/${acc}/shop`, { shopId: s.shopId });
    a.mock.devDuplicateLast(acc, 'mock-thread-olena');
    await a.svc.syncOnce(acc);
    await a.svc.syncOnce(acc);
    expect(msgs(s.shopId)).toHaveLength(n);
  });

  it('new inbound messages are mirrored once, in order, with customer attribution', async () => {
    const s = await shopFor('o@example.com', 'shop-one');
    const acc = await mockAccount(a);
    await a.svc.syncOnce(acc);
    await call(a, a.admin, 'PUT', `/v1/accounts/${acc}/shop`, { shopId: s.shopId });
    const before = msgs(s.shopId).filter((m) => m.conv === 'mock-thread-olena').length;
    a.mock.devInjectIncoming(acc, 'mock-thread-olena', 'Є розмір L?');
    await a.svc.syncOnce(acc);
    await a.svc.syncOnce(acc);
    const after = msgs(s.shopId).filter((m) => m.conv === 'mock-thread-olena');
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ text: 'Є розмір L?', direction: 'incoming', senderType: 'customer', deliveryStatus: 'received', seq: before + 1 });
  });

  it('a send through the connector appears once as a sent outgoing message', async () => {
    const s = await shopFor('o@example.com', 'shop-one');
    const acc = await mockAccount(a);
    await a.svc.syncOnce(acc);
    await call(a, a.admin, 'PUT', `/v1/accounts/${acc}/shop`, { shopId: s.shopId });
    await call(a, a.admin, 'PATCH', `/v1/accounts/${acc}/settings`, { outboundEnabled: true });
    const c = (await call(a, a.admin, 'GET', `/v1/accounts/${acc}/conversations`)).body.items.find((x: any) => x.providerConversationId === 'mock-thread-olena');
    const r = await sendMsg(acc, c.id, 'Так, є', 'send-key-0001');
    expect(r.status).toBe(202);
    await a.svc.whenSendsIdle(acc);
    await a.svc.syncOnce(acc);
    const out = msgs(s.shopId).filter((m) => m.text === 'Так, є');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ direction: 'outgoing', senderType: 'human', senderUserId: null, deliveryStatus: 'sent' });
  });

  it('an uncertain send is mirrored as uncertain, then resolved to sent when the connector confirms it', async () => {
    const s = await shopFor('o@example.com', 'shop-one');
    const acc = await mockAccount(a);
    await a.svc.syncOnce(acc);
    await call(a, a.admin, 'PUT', `/v1/accounts/${acc}/shop`, { shopId: s.shopId });
    await call(a, a.admin, 'PATCH', `/v1/accounts/${acc}/settings`, { outboundEnabled: true });
    const c = (await call(a, a.admin, 'GET', `/v1/accounts/${acc}/conversations`)).body.items.find((x: any) => x.providerConversationId === 'mock-thread-olena');
    a.mock.devPlanSends('uncertain');
    await sendMsg(acc, c.id, 'можливо дійшло', 'resolve-key-01');
    await a.svc.whenSendsIdle(acc);
    expect(msgs(s.shopId).filter((m) => m.text === 'можливо дійшло')).toMatchObject([{ deliveryStatus: 'uncertain' }]);

    const thread = (a.mock as any).accounts.get(acc).threads.get('mock-thread-olena');
    thread.messages.push({ providerMessageId: 'late-1', direction: 'outgoing', text: 'можливо дійшло', attachments: [], sentAt: new Date().toISOString(), ordinal: 99 });
    thread.conv.latestMessageAt = new Date(Date.now() + 1000).toISOString();
    await a.svc.syncOnce(acc);
    const after = msgs(s.shopId).filter((m) => m.text === 'можливо дійшло');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ deliveryStatus: 'sent' });
  });

  it('unlinked accounts mirror nothing; unlink stops mirroring but keeps shop data', async () => {
    const s = await shopFor('o@example.com', 'shop-one');
    const acc = await mockAccount(a);
    await a.svc.syncOnce(acc);
    expect(a.conversations.listConversations(s.shopId).total).toBe(0);
    await call(a, a.admin, 'PUT', `/v1/accounts/${acc}/shop`, { shopId: s.shopId });
    const n = msgs(s.shopId).length;
    expect((await call(a, a.admin, 'DELETE', `/v1/accounts/${acc}/shop`)).body.shopId).toBeNull();
    a.mock.devInjectIncoming(acc, 'mock-thread-olena', 'після відв’язки');
    await a.svc.syncOnce(acc);
    expect(msgs(s.shopId)).toHaveLength(n);
    expect((await call(a, s.token, 'GET', `/v1/shops/${s.shopId}/channels`)).body.items).toEqual([]);
  });

  it('two linked shops stay isolated', async () => {
    const s1 = await shopFor('o1@example.com', 'shop-one');
    const s2 = await shopFor('o2@example.com', 'shop-two');
    const a1 = await mockAccount(a, 'A1');
    const a2 = await mockAccount(a, 'A2');
    await a.svc.syncOnce(a1);
    await a.svc.syncOnce(a2);
    await call(a, a.admin, 'PUT', `/v1/accounts/${a1}/shop`, { shopId: s1.shopId });
    await call(a, a.admin, 'PUT', `/v1/accounts/${a2}/shop`, { shopId: s2.shopId });
    a.mock.devInjectIncoming(a1, 'mock-thread-olena', 'тільки перший магазин');
    await a.svc.syncOnce(a1);
    expect(msgs(s1.shopId).some((m) => m.text === 'тільки перший магазин')).toBe(true);
    expect(msgs(s2.shopId).some((m) => m.text === 'тільки перший магазин')).toBe(false);
    expect((await call(a, s1.token, 'GET', `/v1/shops/${s1.shopId}/channels`)).body.items.map((c: any) => c.accountId)).toEqual([a1]);
    expect((await call(a, s1.token, 'GET', `/v1/shops/${s2.shopId}/channels`)).status).toBe(404);
  });

  it('link rules: admin key only, known ids, no silent re-link to another shop', async () => {
    const s1 = await shopFor('o1@example.com', 'shop-one');
    const s2 = await shopFor('o2@example.com', 'shop-two');
    const acc = await mockAccount(a);
    const url = `/v1/accounts/${acc}/shop`;
    expect((await call(a, s1.token, 'PUT', url, { shopId: s1.shopId })).status).toBe(401); // user session is not an API key
    expect((await call(a, null, 'PUT', url, { shopId: s1.shopId })).status).toBe(401);
    const scoped = a.store.createApiKey('scoped', acc).key;
    expect((await call(a, scoped, 'PUT', url, { shopId: s1.shopId })).status).toBe(403);
    expect((await call(a, a.admin, 'PUT', url, { shopId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await call(a, a.admin, 'PUT', '/v1/accounts/00000000-0000-4000-8000-000000000000/shop', { shopId: s1.shopId })).status).toBe(404);
    expect((await call(a, a.admin, 'PUT', url, { shopId: s1.shopId, extra: 1 })).status).toBe(400);
    expect((await call(a, a.admin, 'PUT', url, { shopId: s1.shopId })).status).toBe(200);
    expect((await call(a, a.admin, 'PUT', url, { shopId: s2.shopId })).status).toBe(400);
    expect(a.store.getAccount(acc)!.shopId).toBe(s1.shopId);
  });

  it('boot backfill repairs a gap', async () => {
    const s = await shopFor('o@example.com', 'shop-one');
    const acc = await mockAccount(a);
    await a.svc.syncOnce(acc);
    a.store.updateAccount(acc, { shopId: s.shopId }); // linked without the route: nothing mirrored yet
    expect(msgs(s.shopId)).toHaveLength(0);
    expect(a.conversations.listConversations(s.shopId).total).toBe(0);
    const n = a.svc.store.listAllForMirror(acc).flatMap((c) => c.messages).length;
    const { ChannelBridge } = await import('../../apps/api/src/services/channel-bridge');
    new ChannelBridge(a.store, a.conversations, { warn() {} }).backfillAll();
    expect(msgs(s.shopId)).toHaveLength(n);
  });
});
