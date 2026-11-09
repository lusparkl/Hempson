import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthRepository,
  ConversationConflictError,
  ConversationNotFoundError,
  ConversationRepository,
  ConversationValidationError,
  ShopRepository,
  openDb,
  runMigrations,
  type DbHandle,
} from '@hepson/database';

let h: DbHandle;
let r: ConversationRepository;
let A: string;
let B: string;
let userA: string;
let tick: number;
beforeEach(async () => {
  h = openDb(':memory:');
  await runMigrations(h);
  const shops = new ShopRepository(h);
  A = (await shops.create({ name: 'A', slug: 'aa' })).id;
  B = (await shops.create({ name: 'B', slug: 'bb' })).id;
  const auth = new AuthRepository(h);
  userA = (await auth.createUser({ email: 'u@example.com', displayName: 'U' }, 'hash')).id;
  await auth.addMember(A, userA, 'owner');
  tick = 0;
  r = new ConversationRepository(h, () => new Date(Date.UTC(2026, 9, 29, 12, 0, tick++)));
});
afterEach(() => h.close());

const msg = (over: Record<string, unknown> = {}) => ({
  channel: 'instagram',
  conversationExternalId: 'thread-1',
  customer: { externalId: 'user-1', displayName: 'Оксана', handle: 'oksana' },
  externalId: 'm1',
  text: 'Привіт, є футболка M?',
  ...over,
});

describe('ingest', () => {
  it('creates customer, conversation and message with order and defaults', async () => {
    const x = await r.ingestMessage(A, msg());
    expect(x.duplicated).toBe(false);
    expect(x.customer).toMatchObject({ shopId: A, channel: 'instagram', externalId: 'user-1', displayName: 'Оксана', handle: 'oksana' });
    expect(x.conversation).toMatchObject({ shopId: A, status: 'open', externalId: 'thread-1' });
    expect(x.conversation.lastMessageAt).toBe(x.message.occurredAt);
    expect(x.message).toMatchObject({ direction: 'incoming', senderType: 'customer', deliveryStatus: 'received', seq: 1, attachments: [], senderUserId: null });
  });

  it('is idempotent: same external id stores once and changes nothing', async () => {
    const first = await r.ingestMessage(A, msg());
    const again = await r.ingestMessage(A, msg({ text: 'edited' }));
    expect(again.duplicated).toBe(true);
    expect(again.message.id).toBe(first.message.id);
    expect(again.message.text).toBe('Привіт, є футболка M?');
    expect((await r.listMessages(A, first.conversation.id)).items).toHaveLength(1);
    expect((await r.listCustomers(A)).total).toBe(1);
    expect((await r.listConversations(A)).total).toBe(1);
  });

  it('assigns increasing seq and tracks the latest occurredAt', async () => {
    const a = await r.ingestMessage(A, msg({ occurredAt: '2026-10-29T10:00:00+02:00' }));
    await r.ingestMessage(A, msg({ externalId: 'm2', occurredAt: '2026-10-29T09:00:00Z' }));
    const c = await r.ingestMessage(A, msg({ externalId: 'm3', occurredAt: '2026-10-29T07:30:00Z' }));
    expect(c.message.seq).toBe(3);
    expect(c.message.occurredAt).toBe('2026-10-29T07:30:00.000Z');
    expect(c.conversation.lastMessageAt).toBe('2026-10-29T09:00:00.000Z');
    expect((await r.listMessages(A, a.conversation.id)).items.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('updates customer name/handle only when new values are given', async () => {
    await r.ingestMessage(A, msg());
    const x = await r.ingestMessage(A, msg({ externalId: 'm2', customer: { externalId: 'user-1', displayName: 'Оксана К.' } }));
    expect(x.customer).toMatchObject({ displayName: 'Оксана К.', handle: 'oksana' });
    expect((await r.listCustomers(A)).total).toBe(1);
  });

  it('reopens a closed conversation on a new inbound message, not on a duplicate', async () => {
    const x = await r.ingestMessage(A, msg());
    await r.setConversationStatus(A, x.conversation.id, 'closed');
    expect((await r.ingestMessage(A, msg())).conversation.status).toBe('closed');
    expect((await r.ingestMessage(A, msg({ externalId: 'm2' }))).conversation.status).toBe('open');
  });

  it('same external ids in different channels or shops do not collide', async () => {
    await r.ingestMessage(A, msg());
    await r.ingestMessage(A, msg({ channel: 'website' }));
    await r.ingestMessage(B, msg());
    expect((await r.listConversations(A)).total).toBe(2);
    expect((await r.listConversations(B)).total).toBe(1);
    expect((await r.listCustomers(A)).total).toBe(2);
  });

  it('rejects a conversation id that belongs to another customer, atomically', async () => {
    await r.ingestMessage(A, msg());
    await expect(async () => await r.ingestMessage(A, msg({ externalId: 'm2', customer: { externalId: 'user-2' } }))).rejects.toThrow(ConversationConflictError);
    expect((await r.listCustomers(A)).total).toBe(1);
  });

  it.each<[Record<string, unknown>, string]>([
    [{ text: '   ' }, 'blank text and no attachment'],
    [{ text: undefined }, 'no content'],
    [{ channel: 'Instagram' }, 'bad channel'],
    [{ externalId: '' }, 'empty message id'],
    [{ conversationExternalId: ' ' }, 'empty conversation id'],
    [{ occurredAt: 'yesterday' }, 'bad time'],
    [{ attachments: [{ kind: '' }] }, 'bad attachment'],
    [{ direction: 'outgoing' }, 'unknown key'],
    [{ text: 'x'.repeat(10_001) }, 'too long'],
  ])('rejects invalid input (%#: %s)', async (over) => {
    await expect(async () => await r.ingestMessage(A, msg(over))).rejects.toThrow(ConversationValidationError);
    expect((await r.listCustomers(A)).total).toBe(0);
  });

  it('accepts an attachment-only message', async () => {
    const x = await r.ingestMessage(A, msg({ text: null, attachments: [{ kind: 'image' }] }));
    expect(x.message).toMatchObject({ text: null, attachments: [{ kind: 'image' }] });
  });

  it('fails on an unknown shop (foreign key)', async () => {
    await expect(async () => await r.ingestMessage('00000000-0000-4000-8000-000000000000', msg())).rejects.toThrow();
  });
});

describe('outbound and delivery', () => {
  const conv = async () => (await r.ingestMessage(A, msg())).conversation.id;

  it('records pending AI and human messages with attribution', async () => {
    const id = await conv();
    const ai = await r.recordOutbound(A, id, { senderType: 'ai', text: 'Так, є' });
    const human = await r.recordOutbound(A, id, { senderType: 'human', senderUserId: userA, text: 'Підтверджую' });
    expect(ai.message).toMatchObject({ direction: 'outgoing', senderType: 'ai', deliveryStatus: 'pending', externalId: null, seq: 2 });
    expect(human.message).toMatchObject({ senderType: 'human', senderUserId: userA, seq: 3 });
  });

  it('allows a human reply with no known user (sent outside Hepson); rejects other bad attribution and fabricated acks', async () => {
    const id = await conv();
    await expect(async () => await r.recordOutbound(A, id, { senderType: 'ai', senderUserId: userA, text: 'x' })).rejects.toThrow(ConversationValidationError);
    await expect(async () => await r.recordOutbound(A, id, { senderType: 'ai', text: 'x', deliveryStatus: 'sent' })).rejects.toThrow(/channel message id/);
    await expect(async () => await r.recordOutbound(A, id, { senderType: 'customer' as never, text: 'x' })).rejects.toThrow(ConversationValidationError);
    expect((await r.recordOutbound(A, id, { senderType: 'human', text: 'x', externalId: 'ig-1', deliveryStatus: 'sent' })).message).toMatchObject({
      senderType: 'human',
      senderUserId: null,
    });
    expect((await r.listMessages(A, id)).items).toHaveLength(2);
  });

  it('human sender must be a member of the same shop', async () => {
    const idB = (await r.ingestMessage(B, msg())).conversation.id;
    await expect(async () => await r.recordOutbound(B, idB, { senderType: 'human', senderUserId: userA, text: 'x' })).rejects.toThrow(/not a member/);
  });

  it('an already-sent message observed on the channel is idempotent', async () => {
    const id = await conv();
    const a = await r.recordOutbound(A, id, { senderType: 'human', senderUserId: userA, text: 'hi', externalId: 'out-1', deliveryStatus: 'sent' });
    const b = await r.recordOutbound(A, id, { senderType: 'human', senderUserId: userA, text: 'hi', externalId: 'out-1', deliveryStatus: 'sent' });
    expect(b.duplicated).toBe(true);
    expect(b.message.id).toBe(a.message.id);
    expect((await r.listMessages(A, id)).items).toHaveLength(2);
  });

  it('delivery transitions: pending -> sent needs an id; sent is final; uncertain can resolve', async () => {
    const id = await conv();
    const p = (await r.recordOutbound(A, id, { senderType: 'ai', text: 'a' })).message;
    await expect(async () => await r.setDeliveryStatus(A, p.id, 'sent')).rejects.toThrow(/externalId/);
    expect(await r.setDeliveryStatus(A, p.id, 'sent', { externalId: 'ig-9' })).toMatchObject({ deliveryStatus: 'sent', externalId: 'ig-9', deliveryError: null });
    await expect(async () => await r.setDeliveryStatus(A, p.id, 'failed')).rejects.toThrow(/cannot change sent -> failed/);

    const u = (await r.recordOutbound(A, id, { senderType: 'ai', text: 'b' })).message;
    expect(await r.setDeliveryStatus(A, u.id, 'uncertain', { error: 'send click, no confirmation' })).toMatchObject({
      deliveryStatus: 'uncertain',
      deliveryError: 'send click, no confirmation',
    });
    expect((await r.setDeliveryStatus(A, u.id, 'failed', { error: 'owner checked' })).deliveryStatus).toBe('failed');

    const incoming = (await r.listMessages(A, id)).items[0]!;
    await expect(async () => await r.setDeliveryStatus(A, incoming.id, 'failed')).rejects.toThrow(ConversationValidationError);
  });

  it('rejects a channel id already stored in the conversation', async () => {
    const id = await conv();
    const p = (await r.recordOutbound(A, id, { senderType: 'ai', text: 'a' })).message;
    await expect(async () => await r.setDeliveryStatus(A, p.id, 'sent', { externalId: 'm1' })).rejects.toThrow(ConversationConflictError);
    expect((await r.getMessage(A, p.id))!.deliveryStatus).toBe('pending');
  });
});

describe('reads and shop isolation', () => {
  it('lists conversations newest activity first, with filters and paging', async () => {
    const a = await r.ingestMessage(A, msg({ conversationExternalId: 't1', customer: { externalId: 'c1' }, externalId: 'a1' }));
    const b = await r.ingestMessage(A, msg({ conversationExternalId: 't2', customer: { externalId: 'c2' }, externalId: 'b1' }));
    await r.ingestMessage(A, msg({ conversationExternalId: 't1', customer: { externalId: 'c1' }, externalId: 'a2' }));
    await r.setConversationStatus(A, b.conversation.id, 'closed');
    expect((await r.listConversations(A)).items.map((x) => x.conversation.id)).toEqual([a.conversation.id, b.conversation.id]);
    expect((await r.listConversations(A, { status: 'closed' })).items.map((x) => x.conversation.id)).toEqual([b.conversation.id]);
    expect((await r.listConversations(A, { customerId: a.customer.id })).total).toBe(1);
    expect(await r.listConversations(A, { limit: 1, offset: 1 })).toMatchObject({ total: 2, items: [{ conversation: { id: b.conversation.id } }] });
  });

  it('pages messages backwards, oldest first within a page', async () => {
    let id = '';
    for (let i = 1; i <= 5; i++) id = (await r.ingestMessage(A, msg({ externalId: `m${i}`, text: `t${i}` }))).conversation.id;
    const p1 = await r.listMessages(A, id, { limit: 2 });
    expect(p1.items.map((m) => m.text)).toEqual(['t4', 't5']);
    expect(p1.hasMore).toBe(true);
    const p2 = await r.listMessages(A, id, { limit: 2, beforeSeq: p1.items[0]!.seq });
    expect(p2.items.map((m) => m.text)).toEqual(['t2', 't3']);
    const p3 = await r.listMessages(A, id, { limit: 2, beforeSeq: p2.items[0]!.seq });
    expect(p3).toMatchObject({ hasMore: false, items: [{ text: 't1' }] });
  });

  it("another shop cannot see, read, write or change a shop's data", async () => {
    const x = await r.ingestMessage(A, msg());
    const m = (await r.recordOutbound(A, x.conversation.id, { senderType: 'ai', text: 'hi' })).message;
    expect(await r.getConversation(B, x.conversation.id)).toBeUndefined();
    expect(await r.getCustomer(B, x.customer.id)).toBeUndefined();
    expect(await r.getMessage(B, m.id)).toBeUndefined();
    expect((await r.listConversations(B)).total).toBe(0);
    expect((await r.listCustomers(B)).total).toBe(0);
    await expect(async () => await r.listMessages(B, x.conversation.id)).rejects.toThrow(ConversationNotFoundError);
    await expect(async () => await r.recordOutbound(B, x.conversation.id, { senderType: 'ai', text: 'x' })).rejects.toThrow(ConversationNotFoundError);
    await expect(async () => await r.setDeliveryStatus(B, m.id, 'failed')).rejects.toThrow(ConversationNotFoundError);
    await expect(async () => await r.setConversationStatus(B, x.conversation.id, 'closed')).rejects.toThrow(ConversationNotFoundError);
    expect((await r.getMessage(A, m.id))!.deliveryStatus).toBe('pending');
    expect((await r.getConversation(A, x.conversation.id))!.conversation.status).toBe('open');
  });

  it('DB rejects inconsistent sender/direction even when bypassing the repository', async () => {
    const x = await r.ingestMessage(A, msg());
    const ins = (dir: string, sender: string) =>
      h.raw
        .prepare(
          `insert into shop_messages (id, shop_id, conversation_id, direction, sender_type, attachments, delivery_status, seq, occurred_at, created_at, updated_at)
           values (lower(hex(randomblob(8))), ?, ?, ?, ?, '[]', 'pending', 99, 'x', 'x', 'x')`,
        )
        .run(A, x.conversation.id, dir, sender);
    expect(() => ins('incoming', 'ai')).toThrow(/CHECK/);
    expect(() => ins('outgoing', 'customer')).toThrow(/CHECK/);
    expect(() => ins('outgoing', 'ai')).not.toThrow();
  });
});
