import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openDb, runMigrations } from '@hepson/database';
import { noticeText } from '../../apps/api/src/services/customer-notices';
import { paymentText } from '../../apps/api/src/services/payments';
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
const checkout = {
  firstName: 'Оксана',
  lastName: 'Мельник',
  phone: '050 111 22 33',
  npCityRef: 'city-kyiv',
  npCityName: 'Київ',
  npWarehouseRef: 'wh-5',
  npWarehouseName: 'Відділення №5',
  paymentMethod: 'cod' as const,
};

async function setup() {
  const owner = await signup('owner@example.com');
  const mgr = await signup('mgr@example.com');
  const out = await signup('out@example.com');
  const shop = (await call(a, owner, 'POST', '/v1/shops', { name: 'S', slug: 'shop-one' })).body.shopId as string;
  await call(a, owner, 'POST', `/v1/shops/${shop}/members`, { email: 'mgr@example.com', role: 'manager' });
  const other = (await call(a, out, 'POST', '/v1/shops', { name: 'O', slug: 'shop-two' })).body.shopId as string;
  for (const s of [shop, other])
    await a.catalog.createProduct(s, { name: 'Худі', priceMinor: 100_000, currency: 'UAH', variants: [{ sku: 'H-M', options: { size: 'M' }, stock: 50 }] });
  const ingest = async (shopId: string, thread: string, ext: string, text: string, customer = 'u1') =>
    await a.conversations.ingestMessage(shopId, {
      channel: 'instagram',
      conversationExternalId: thread,
      customer: { externalId: customer, displayName: 'Оксана' },
      externalId: ext,
      text,
    });
  const draft = async (shopId: string, conversationId: string, over: Record<string, unknown> = {}) =>
    (await a.orders.createDraft(shopId, { conversationId, createdBy: 'ai', items: [{ sku: 'H-M', quantity: 1 }], checkout, ...over })).draft;
  return { owner, mgr, out, shop, other, ingest, draft };
}

describe('P10 conversation list fields', () => {
  it('shows the newest non-system message and per-member unread state', async () => {
    const { owner, mgr, out, shop, ingest } = await setup();
    const x = await ingest(shop, 't1', 'm1', 'Привіт');
    const url = `/v1/shops/${shop}/conversations`;
    let list = (await call(a, owner, 'GET', url)).body;
    expect(list.items[0]).toMatchObject({ conversationId: x.conversation.id, unread: true, lastMessage: { text: 'Привіт', senderType: 'customer', attachments: 0 } });
    expect((await call(a, owner, 'GET', `${url}/unread-count`)).body).toEqual({ count: 1 });

    await a.conversations.recordOutbound(shop, x.conversation.id, { senderType: 'ai', text: 'Вітаю! Чим допомогти?' });
    await a.conversations.recordOutbound(shop, x.conversation.id, { senderType: 'system', text: 'ШІ створив чернетку' });
    list = (await call(a, owner, 'GET', url)).body;
    // System lines are skipped; an AI reply does not make the conversation read.
    expect(list.items[0]).toMatchObject({ unread: true, lastMessage: { text: 'Вітаю! Чим допомогти?', senderType: 'ai' } });

    // The owner reads it; the manager still has it unread.
    expect((await call(a, owner, 'PUT', `${url}/${x.conversation.id}/read`, {})).body).toEqual({ lastSeenSeq: 3, unread: false });
    expect((await call(a, owner, 'GET', `${url}/unread-count`)).body.count).toBe(0);
    expect((await call(a, mgr, 'GET', `${url}/unread-count`)).body.count).toBe(1);
    expect((await call(a, mgr, 'GET', `${url}/${x.conversation.id}`)).body).toMatchObject({ unread: true, lastMessage: { senderType: 'ai' } });

    // A new customer message makes it unread again; the marker never moves back.
    await ingest(shop, 't1', 'm2', 'Є розмір M?');
    expect((await call(a, owner, 'GET', `${url}/${x.conversation.id}`)).body.unread).toBe(true);
    expect((await call(a, owner, 'PUT', `${url}/${x.conversation.id}/read`, { seq: 1 })).body).toEqual({ lastSeenSeq: 3, unread: true });
    expect((await call(a, owner, 'PUT', `${url}/${x.conversation.id}/read`, { seq: 99 })).body).toEqual({ lastSeenSeq: 4, unread: false });

    // Attachment-only message: no text, attachment count.
    await a.conversations.ingestMessage(shop, {
      channel: 'instagram',
      conversationExternalId: 't1',
      customer: { externalId: 'u1' },
      externalId: 'm3',
      attachments: [{ kind: 'image' }],
    });
    expect((await call(a, owner, 'GET', `${url}/${x.conversation.id}`)).body.lastMessage).toMatchObject({ text: null, attachments: 1 });

    // Outsiders and other shops' ids get 404 / 400.
    expect((await call(a, out, 'GET', `${url}/unread-count`)).status).toBe(404);
    expect((await call(a, out, 'PUT', `${url}/${x.conversation.id}/read`, {})).status).toBe(404);
    expect((await call(a, owner, 'PUT', `${url}/${x.conversation.id}/read`, { seq: -1 })).status).toBe(400);
  });

  it('another shop cannot mark this conversation read through its own path', async () => {
    const { owner, out, shop, other, ingest } = await setup();
    const x = await ingest(shop, 't1', 'm1', 'Привіт');
    expect((await call(a, out, 'PUT', `/v1/shops/${other}/conversations/${x.conversation.id}/read`, {})).status).toBe(404);
    expect((await call(a, owner, 'GET', `/v1/shops/${shop}/conversations/unread-count`)).body.count).toBe(1);
  });
});

describe('P10 customer card', () => {
  it('stores a private note and shows contacts and orders across conversations', async () => {
    const { owner, mgr, out, shop, other, ingest, draft } = await setup();
    const c1 = await ingest(shop, 't1', 'm1', 'Привіт');
    const c2 = await ingest(shop, 't2', 'm2', 'Ще одне замовлення');
    expect(c2.customer.id).toBe(c1.customer.id);
    const curl = `/v1/shops/${shop}/customers/${c1.customer.id}`;

    let card = (await call(a, owner, 'GET', curl)).body;
    expect(card).toMatchObject({ customerId: c1.customer.id, note: null, profile: { phone: null, city: null, orders: { count: 0, placed: 0, totals: [], lastAt: null } } });

    const d1 = await draft(shop, c1.conversation.id);
    await draft(shop, c2.conversation.id, { createdBy: 'user', checkout: { ...checkout, npCityName: 'Львів', phone: '067 000 11 22' } });
    await a.orders.reject(shop, d1.id, (await a.auth.getUserByEmail('owner@example.com'))!.id);
    card = (await call(a, owner, 'GET', curl)).body;
    // Newest order with contacts wins; the rejected order counts in `count` but not in the totals.
    expect(card.profile).toMatchObject({ phone: '+380670001122', city: 'Львів', orders: { count: 2, placed: 1, totals: [{ currency: 'UAH', totalMinor: 100_000 }] } });
    const byCustomer = (await call(a, owner, 'GET', `/v1/shops/${shop}/order-drafts?customerId=${c1.customer.id}`)).body;
    expect(byCustomer.total).toBe(2);

    expect((await call(a, mgr, 'PUT', `${curl}/note`, { note: '  Любить худі оверсайз  ' })).body).toMatchObject({ note: 'Любить худі оверсайз' });
    expect((await call(a, owner, 'GET', curl)).body.note).toBe('Любить худі оверсайз');
    expect((await call(a, owner, 'GET', `/v1/shops/${shop}/conversations/${c1.conversation.id}`)).body.customer.note).toBe('Любить худі оверсайз');
    expect((await call(a, owner, 'PUT', `${curl}/note`, { note: 'x'.repeat(2001) })).status).toBe(400);
    expect((await call(a, owner, 'PUT', `${curl}/note`, { note: '' })).body.note).toBeNull();

    // Tenant isolation: another shop's member and another shop's path see nothing.
    expect((await call(a, out, 'GET', curl)).status).toBe(404);
    expect((await call(a, out, 'PUT', `/v1/shops/${other}/customers/${c1.customer.id}/note`, { note: 'hi' })).status).toBe(404);
    expect((await call(a, out, 'GET', `/v1/shops/${other}/customers/${c1.customer.id}`)).status).toBe(404);
  });
});

describe('P10 order numbers', () => {
  it('numbers orders per shop in creation order and shows them in the API', async () => {
    const { owner, shop, other, ingest, draft } = await setup();
    const x = await ingest(shop, 't1', 'm1', 'Привіт');
    const y = await ingest(other, 't1', 'm1', 'Привіт');
    const n1 = (await draft(shop, x.conversation.id, { createdBy: 'user' })).number;
    const n2 = (await draft(shop, x.conversation.id, { createdBy: 'user' })).number;
    const o1 = (await draft(other, y.conversation.id)).number;
    expect([n1, n2, o1]).toEqual([1, 2, 1]);
    const list = (await call(a, owner, 'GET', `/v1/shops/${shop}/order-drafts`)).body;
    expect(list.items.map((d: { number: number }) => d.number)).toEqual([2, 1]);
    // Customers see the same number as the shop.
    const d2 = (await a.orders.listDrafts(shop)).items[0]!.draft;
    expect(noticeText('delivered', d2, 'uk')).toBe('Замовлення №2 отримано. Дякуємо за покупку!');
    expect(paymentText('link', { language: 'uk', order: '№2', amountMinor: 100_000, url: 'https://pay.example/x', expiresAt: '2026-11-04T10:00:00Z' })).toContain(
      'Замовлення №2 підтверджено',
    );
  });

  it('the migration numbers existing orders and marks existing history as seen', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hepson-mig-'));
    try {
      // Migrations folder up to 0015, as before the upgrade.
      const old = path.join(dir, 'migrations');
      mkdirSync(path.join(old, 'meta'), { recursive: true });
      const before = (name: string) => Number(name.slice(0, 4)) < 16;
      for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql') && before(f)) copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(old, f));
      const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
      writeFileSync(path.join(old, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter((e) => before(e.tag)) }));
      const h = openDb(path.join(dir, 'db.sqlite'));
      migrate(h.db, { migrationsFolder: old });
      const ts = (i: number) => `2026-10-0${i}T10:00:00.000Z`;
      const run = (sql: string, ...v: unknown[]) => h.raw.prepare(sql).run(...v);
      run(`insert into shops (id, name, slug, created_at, updated_at) values ('s1', 'S1', 's-one', ?, ?), ('s2', 'S2', 's-two', ?, ?)`, ts(1), ts(1), ts(1), ts(1));
      run(`insert into users (id, email, display_name, password_hash, created_at, updated_at) values ('u1', 'u@x.io', 'U', 'h', ?, ?)`, ts(1), ts(1));
      run(`insert into memberships (id, shop_id, user_id, role, created_at) values ('m1', 's1', 'u1', 'owner', ?)`, ts(1));
      for (const s of ['s1', 's2']) {
        run(`insert into customers (id, shop_id, channel, external_id, created_at, updated_at) values (?, ?, 'instagram', 'c', ?, ?)`, `c-${s}`, s, ts(1), ts(1));
        run(
          `insert into shop_conversations (id, shop_id, customer_id, channel, external_id, created_at, updated_at) values (?, ?, ?, 'instagram', 't', ?, ?)`,
          `v-${s}`,
          s,
          `c-${s}`,
          ts(1),
          ts(1),
        );
        run(
          `insert into shop_messages (id, shop_id, conversation_id, direction, sender_type, attachments, delivery_status, seq, occurred_at, created_at, updated_at) values (?, ?, ?, 'incoming', 'customer', '[]', 'received', 1, ?, ?, ?)`,
          `msg-${s}`,
          s,
          `v-${s}`,
          ts(1),
          ts(1),
          ts(1),
        );
      }
      const order = (id: string, shop: string, day: number) =>
        run(
          `insert into order_drafts (id, shop_id, conversation_id, customer_id, status, created_by, currency, total_minor, created_at, updated_at) values (?, ?, ?, ?, 'pending_approval', 'ai', 'UAH', 100, ?, ?)`,
          id,
          shop,
          `v-${shop}`,
          `c-${shop}`,
          ts(day),
          ts(day),
        );
      order('d-late', 's1', 3);
      order('d-early', 's1', 2);
      order('d-other', 's2', 4);
      await runMigrations(h);
      const nums = h.raw.prepare(`select id, number from order_drafts order by id`).all();
      expect(nums).toEqual([
        { id: 'd-early', number: 1 },
        { id: 'd-late', number: 2 },
        { id: 'd-other', number: 1 },
      ]);
      expect(h.raw.prepare(`select conversation_id c, user_id u, last_seen_seq s from conversation_reads`).all()).toEqual([{ c: 'v-s1', u: 'u1', s: 1 }]);
      expect(h.raw.prepare(`select count(*) n from notification_reads`).get()).toEqual({ n: 1 });
      h.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P10 notification feed', () => {
  it('lists hand-offs, new orders, payment and TTN problems with per-member read state', async () => {
    const { owner, mgr, out, shop, other, ingest, draft } = await setup();
    const x = await ingest(shop, 't1', 'm1', 'Привіт');
    const feedUrl = `/v1/shops/${shop}/notification-feed`;
    expect((await call(a, owner, 'GET', feedUrl)).body).toEqual({ seenAt: null, unread: 0, items: [] });

    const esc = (await a.agentRepo.escalate(shop, x.conversation.id, 'Питання про знижку')).escalation;
    const d = await draft(shop, x.conversation.id);
    a.handle.raw.prepare(`update order_drafts set ttn_state = 'failed', ttn_error = 'NP refused' where id = ?`).run(d.id);
    const now = new Date().toISOString();
    a.handle.raw
      .prepare(
        `insert into order_payments (id, shop_id, draft_id, provider, state, active, amount_minor, currency, expires_at, created_at, updated_at) values ('pay-1', ?, ?, 'monobank', 'failure', 0, 100000, 'UAH', ?, ?, ?)`,
      )
      .run(shop, d.id, now, now, now);
    // Noise in another shop must not show up.
    const y = await ingest(other, 't1', 'm1', 'Привіт');
    await a.agentRepo.escalate(other, y.conversation.id, 'Чужий запит');

    let f = (await call(a, owner, 'GET', feedUrl)).body;
    expect(f.unread).toBe(4);
    expect(f.items.map((i: { kind: string }) => i.kind).sort()).toEqual(['handoff', 'order_new', 'payment_problem', 'ttn_problem']);
    expect(f.items.find((i: { kind: string }) => i.kind === 'handoff')).toMatchObject({
      conversationId: x.conversation.id,
      reason: 'Питання про знижку',
      resolved: false,
      customer: 'Оксана',
      unread: true,
    });
    expect(f.items.find((i: { kind: string }) => i.kind === 'order_new')).toMatchObject({ draftId: d.id, number: 1, totalMinor: 100_000, createdBy: 'ai' });
    expect(f.items.find((i: { kind: string }) => i.kind === 'ttn_problem')).toMatchObject({ draftId: d.id, ttnState: 'failed', ttnError: 'NP refused' });
    expect(f.items.find((i: { kind: string }) => i.kind === 'payment_problem')).toMatchObject({ draftId: d.id, state: 'failure' });

    // The owner marks all seen; the manager still has 4 unread.
    const seen = (await call(a, owner, 'POST', `${feedUrl}/seen`)).body.seenAt as string;
    f = (await call(a, owner, 'GET', feedUrl)).body;
    expect(f).toMatchObject({ seenAt: seen, unread: 0 });
    expect(f.items.every((i: { unread: boolean }) => !i.unread)).toBe(true);
    expect((await call(a, mgr, 'GET', feedUrl)).body.unread).toBe(4);

    // Resolving shows in the item; a later hand-off is unread again.
    await new Promise((r) => setTimeout(r, 5));
    await a.agentRepo.resolveEscalation(shop, esc.id, null);
    await a.agentRepo.escalate(shop, x.conversation.id, 'Ще питання');
    f = (await call(a, owner, 'GET', feedUrl)).body;
    expect(f.unread).toBe(1);
    expect(f.items[0]).toMatchObject({ kind: 'handoff', reason: 'Ще питання', unread: true });
    expect(f.items.find((i: { id: string }) => i.id === `handoff:${esc.id}`)).toMatchObject({ resolved: true, unread: false });
    expect((await call(a, owner, 'GET', `${feedUrl}?limit=2`)).body.items).toHaveLength(2);

    expect((await call(a, out, 'GET', feedUrl)).status).toBe(404);
    expect((await call(a, out, 'POST', `${feedUrl}/seen`)).status).toBe(404);
    expect((await call(a, out, 'GET', `/v1/shops/${other}/notification-feed`)).body.items).toHaveLength(1);
  });
});
