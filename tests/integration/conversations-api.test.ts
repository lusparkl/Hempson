import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, call, type TestApp } from '../helpers';

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
async function setup() {
  const owner = await signup('owner@example.com');
  const mgr = await signup('mgr@example.com');
  const out = await signup('out@example.com');
  const shop = (await call(a, owner, 'POST', '/v1/shops', { name: 'S', slug: 'shop-one' })).body.shopId as string;
  await call(a, owner, 'POST', `/v1/shops/${shop}/members`, { email: 'mgr@example.com', role: 'manager' });
  const other = (await call(a, out, 'POST', '/v1/shops', { name: 'O', slug: 'shop-two' })).body.shopId as string;
  const seed = (shopId: string) => {
    const x = a.conversations.ingestMessage(shopId, {
      channel: 'instagram',
      conversationExternalId: 't1',
      customer: { externalId: 'u1', displayName: 'Оксана' },
      externalId: 'm1',
      text: 'Привіт',
    });
    a.conversations.ingestMessage(shopId, { channel: 'instagram', conversationExternalId: 't1', customer: { externalId: 'u1' }, externalId: 'm2', text: 'Є розмір M?' });
    a.conversations.recordOutbound(shopId, x.conversation.id, { senderType: 'ai', text: 'Так' });
    return x;
  };
  return { owner, mgr, out, shop, other, seed };
}

describe('conversation read API', () => {
  it('any member lists customers, conversations and messages', async () => {
    const { owner, mgr, shop, seed } = await setup();
    const x = seed(shop);
    for (const token of [owner, mgr]) {
      const customers = await call(a, token, 'GET', `/v1/shops/${shop}/customers`);
      expect(customers.body).toMatchObject({ total: 1, items: [{ customerId: x.customer.id, channel: 'instagram', displayName: 'Оксана' }] });

      const list = await call(a, token, 'GET', `/v1/shops/${shop}/conversations?status=open`);
      expect(list.body).toMatchObject({ total: 1, items: [{ conversationId: x.conversation.id, status: 'open', customer: { externalId: 'u1' } }] });

      const one = await call(a, token, 'GET', `/v1/shops/${shop}/conversations/${x.conversation.id}`);
      expect(one.status).toBe(200);
      expect(one.body.customer.customerId).toBe(x.customer.id);

      const msgs = await call(a, token, 'GET', `/v1/shops/${shop}/conversations/${x.conversation.id}/messages`);
      expect(msgs.body.hasMore).toBe(false);
      expect(msgs.body.items.map((m: { seq: number; senderType: string; deliveryStatus: string }) => [m.seq, m.senderType, m.deliveryStatus])).toEqual([
        [1, 'customer', 'received'],
        [2, 'customer', 'received'],
        [3, 'ai', 'pending'],
      ]);
    }
  });

  it('pages messages with limit and beforeSeq', async () => {
    const { owner, shop, seed } = await setup();
    const x = seed(shop);
    const p1 = await call(a, owner, 'GET', `/v1/shops/${shop}/conversations/${x.conversation.id}/messages?limit=2`);
    expect(p1.body).toMatchObject({ hasMore: true, items: [{ seq: 2 }, { seq: 3 }] });
    const p2 = await call(a, owner, 'GET', `/v1/shops/${shop}/conversations/${x.conversation.id}/messages?limit=2&beforeSeq=2`);
    expect(p2.body).toMatchObject({ hasMore: false, items: [{ seq: 1 }] });
  });

  it('non-members get 404 and see nothing; ids from another shop are 404', async () => {
    const { out, owner, shop, other, seed } = await setup();
    const x = seed(shop);
    const y = seed(other);
    for (const path of ['customers', 'conversations', `conversations/${x.conversation.id}`, `conversations/${x.conversation.id}/messages`]) {
      expect((await call(a, out, 'GET', `/v1/shops/${shop}/${path}`)).status).toBe(404);
    }
    // member of one shop asking the own shop for the other shop's conversation id
    expect((await call(a, owner, 'GET', `/v1/shops/${shop}/conversations/${y.conversation.id}`)).status).toBe(404);
    expect((await call(a, owner, 'GET', `/v1/shops/${shop}/conversations/${y.conversation.id}/messages`)).status).toBe(404);
    expect((await call(a, out, 'GET', `/v1/shops/${other}/conversations`)).body.total).toBe(1);
    expect((await call(a, owner, 'GET', `/v1/shops/${shop}/conversations?customerId=${y.customer.id}`)).body.total).toBe(0);
  });

  it('requires a user session; API keys and anonymous calls are rejected', async () => {
    const { shop } = await setup();
    const url = `/v1/shops/${shop}/conversations`;
    expect((await call(a, null, 'GET', url)).status).toBe(401);
    expect((await call(a, a.admin, 'GET', url)).status).toBe(401);
  });

  it('validates query and ids', async () => {
    const { owner, shop } = await setup();
    expect((await call(a, owner, 'GET', `/v1/shops/${shop}/conversations?limit=0`)).status).toBe(400);
    expect((await call(a, owner, 'GET', `/v1/shops/${shop}/conversations?status=bogus`)).status).toBe(400);
    expect((await call(a, owner, 'GET', `/v1/shops/${shop}/conversations/not-a-uuid`)).status).toBe(400);
  });
});
