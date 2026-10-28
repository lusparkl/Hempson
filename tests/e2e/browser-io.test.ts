import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call } from '../helpers';
import { FakeInstagram, seedThreads } from '../fixtures/fake-instagram';
import { bootApi, createReal, eventTypes, ownerLogsIn, status, until, type Booted } from './helpers';

let fake: FakeInstagram;
const live: Booted[] = [];
beforeAll(async () => {
  fake = await new FakeInstagram().start();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(() => {
  fake.users.clear();
  fake.sessions.clear();
  fake.sendClicks = 0;
  Object.assign(fake.mode, { checkpoint: false, sendMode: 'ok', renameHeading: false, sessionLife: 3600 });
  fake.addUser('shop_a', seedThreads());
});
afterEach(async () => {
  for (const b of live.splice(0)) await b.close().catch(() => undefined);
});

async function connected() {
  const b = await bootApi(fake);
  live.push(b);
  const A = await createReal(b, 'shop-a', 'shop_a');
  await call(b, b.admin, 'POST', `/v1/accounts/${A}/session/start`, { interactive: true });
  await ownerLogsIn(b, A, fake, 'shop_a');
  await until(async () => (await status(b, A)).status === 'connected', 15_000);
  await b.svc.syncOnce(A);
  return { b, A };
}
const convByTitle = async (b: Booted, A: string, title: string) =>
  (await call(b, b.admin, 'GET', `/v1/accounts/${A}/conversations`)).body.items.find((c: any) => c.title === title);
const msgs = async (b: Booted, A: string, cid: string) => (await call(b, b.admin, 'GET', `/v1/accounts/${A}/conversations/${cid}/messages`)).body.items;
const send = (b: Booted, A: string, cid: string, text: string, key: string) =>
  call(b, b.admin, 'POST', `/v1/accounts/${A}/conversations/${cid}/messages`, { text, idempotencyKey: key });

describe('browser reading (fake Instagram DOM)', () => {
  it('lists conversations and extracts text, direction, null timestamps, media placeholder', async () => {
    const { b, A } = await connected();
    const c = await convByTitle(b, A, 'Олена Коваль');
    expect(c.providerConversationId).toBe('abc111');
    expect(c.participantHandles).toEqual(['olena.koval']);
    const m = await msgs(b, A, c.id);
    expect(m.map((x: any) => x.direction)).toEqual(['incoming', 'outgoing', 'incoming']);
    expect(m[0].text).toBe('Доброго дня! Є сукня M?');
    expect(m[0].sentAt).toBe('2026-10-20T09:00:00.000Z');
    expect(m[2].text).toBeNull();
    expect(m[2].sentAt).toBeNull();
    expect(m[2].attachments).toEqual([{ kind: 'image', metadata: { note: 'unsupported_media_placeholder' } }]);
  });
  it('exactly one message.received per new inbound, across repeated syncs and restart', async () => {
    const { b, A } = await connected();
    const n0 = (await eventTypes(b, A)).filter((t) => t === 'message.received').length;
    expect(n0).toBe(0);
    fake.injectIncoming('shop_a', 'def222', 'А є розмір 42?');
    await b.svc.syncOnce(A);
    await b.svc.syncOnce(A);
    (b.svc as any).sigs.clear();
    await b.svc.syncOnce(A);
    expect((await eventTypes(b, A)).filter((t) => t === 'message.received').length).toBe(1);
    fake.injectIncoming('shop_a', 'def222', 'А є розмір 42?'); // same text again => a genuinely new message
    await b.svc.syncOnce(A);
    expect((await eventTypes(b, A)).filter((t) => t === 'message.received').length).toBe(2);
  });
  it('title mismatch refuses to act (never silently wrong chat)', async () => {
    const { b, A } = await connected();
    const c = await convByTitle(b, A, 'Андрій Мельник');
    b.handle.raw.prepare('update conversations set title = ? where id = ?').run('Інша людина', c.id); // cached title no longer matches what the page shows
    await call(b, b.admin, 'PATCH', `/v1/accounts/${A}/settings`, { outboundEnabled: true });
    const r = await send(b, A, c.id, 'privacy test', 'mismatch-key-01');
    await b.svc.whenSendsIdle(A);
    const ob = (await call(b, b.admin, 'GET', `/v1/accounts/${A}/outbox/${r.body.outboxId}`)).body;
    expect(ob.status).toBe('failed');
    expect(ob.errorCode).toBe('UI_CHANGED');
    expect(fake.sendClicks).toBe(0);
  });
});

describe('browser sending (fake Instagram DOM)', () => {
  it('default blocked; enabled => sent, verified in UI, no duplicate on next sync', async () => {
    const { b, A } = await connected();
    const c = await convByTitle(b, A, 'Андрій Мельник');
    expect((await send(b, A, c.id, 'x', 'blocked-key-001')).body.error.code).toBe('OUTBOUND_DISABLED');
    await call(b, b.admin, 'PATCH', `/v1/accounts/${A}/settings`, { outboundEnabled: true });
    const r = await send(b, A, c.id, 'Ремінь коштує 600 грн', 'send-key-0001');
    expect(r.status).toBe(202);
    await b.svc.whenSendsIdle(A);
    expect((await call(b, b.admin, 'GET', `/v1/accounts/${A}/outbox/${r.body.outboxId}`)).body.status).toBe('sent');
    expect(fake.sendClicks).toBe(1);
    await b.svc.syncOnce(A);
    (b.svc as any).sigs.clear();
    await b.svc.syncOnce(A);
    const m = (await msgs(b, A, c.id)).filter((x: any) => x.text === 'Ремінь коштує 600 грн');
    expect(m).toHaveLength(1);
    expect(m[0].direction).toBe('outgoing');
    expect(
      fake.users
        .get('shop_a')!
        .threads.get('def222')!
        .messages.filter((x) => x.text === 'Ремінь коштує 600 грн'),
    ).toHaveLength(1);
    // repeating the key does not click again
    await send(b, A, c.id, 'Ремінь коштує 600 грн', 'send-key-0001');
    await b.svc.whenSendsIdle(A);
    expect(fake.sendClicks).toBe(1);
  });
  it('unconfirmed echo => uncertain, never retried, composer cleared', async () => {
    const { b, A } = await connected();
    const c = await convByTitle(b, A, 'Андрій Мельник');
    await call(b, b.admin, 'PATCH', `/v1/accounts/${A}/settings`, { outboundEnabled: true });
    fake.mode.sendMode = 'no-echo';
    const r = await send(b, A, c.id, 'echo test', 'uncertain-key-1');
    await b.svc.whenSendsIdle(A);
    const ob = (await call(b, b.admin, 'GET', `/v1/accounts/${A}/outbox/${r.body.outboxId}`)).body;
    expect(ob).toMatchObject({ status: 'uncertain', needsReview: true });
    await b.svc.syncOnce(A);
    await b.svc.syncOnce(A);
    expect(fake.sendClicks).toBe(1);
    // if the owner later sees it did go through, the next observation resolves it without a 2nd message
    fake.users.get('shop_a')!.threads.get('def222')!.messages.push({ id: 'late', from: 'me', text: 'echo test', at: new Date().toISOString() });
    (b.svc as any).sigs.clear();
    await b.svc.syncOnce(A);
    expect((await call(b, b.admin, 'GET', `/v1/accounts/${A}/outbox/${r.body.outboxId}`)).body.status).toBe('sent');
    expect((await msgs(b, A, c.id)).filter((x: any) => x.text === 'echo test')).toHaveLength(1);
  });
  it('missing composer => UI_CHANGED, failed before any click', async () => {
    const { b, A } = await connected();
    const c = await convByTitle(b, A, 'Андрій Мельник');
    await call(b, b.admin, 'PATCH', `/v1/accounts/${A}/settings`, { outboundEnabled: true });
    fake.mode.sendMode = 'no-composer';
    const r = await send(b, A, c.id, 'x', 'nocomposer-key1');
    await b.svc.whenSendsIdle(A);
    const ob = (await call(b, b.admin, 'GET', `/v1/accounts/${A}/outbox/${r.body.outboxId}`)).body;
    expect(ob).toMatchObject({ status: 'failed', errorCode: 'UI_CHANGED' });
    expect(fake.sendClicks).toBe(0);
  });
  it('serialized queue: two sends run one after another, both delivered once', async () => {
    const { b, A } = await connected();
    const c = await convByTitle(b, A, 'Андрій Мельник');
    await call(b, b.admin, 'PATCH', `/v1/accounts/${A}/settings`, { outboundEnabled: true });
    await send(b, A, c.id, 'перше', 'serial-key-001');
    await send(b, A, c.id, 'друге', 'serial-key-002');
    await b.svc.whenSendsIdle(A);
    const texts = fake.users
      .get('shop_a')!
      .threads.get('def222')!
      .messages.filter((x) => x.from === 'me')
      .map((x) => x.text);
    expect(texts).toEqual(['перше', 'друге']);
  });
});

describe('selector failure / UI change', () => {
  it('unparseable inbox raises UI_CHANGED (never guesses)', async () => {
    const { b, A } = await connected();
    const page = (b.adapter as any).sessions.get(A).page;
    await page.route('**/direct/inbox/**', (r: any) =>
      r.fulfill({ contentType: 'text/html', body: '<nav><a href="/shop_a/" aria-label="Profile">p</a></nav><main><a href="/direct/t/zzz/"></a></main>' }),
    );
    (b.svc as any).sigs.clear();
    await expect(b.svc.syncOnce(A)).rejects.toMatchObject({ code: 'UI_CHANGED' });
  });
  it('worker marks the account degraded (not connected) on UI_CHANGED', async () => {
    const { b, A } = await connected();
    const page = (b.adapter as any).sessions.get(A).page;
    await page.route('**/direct/inbox/**', (r: any) => r.fulfill({ contentType: 'text/html', body: '<main><a href="/direct/t/zzz/"></a></main>' }));
    (b.svc as any).handleSyncError(A, new (await import('@hepson/connector-core')).ConnectorError('UI_CHANGED', 'x'), { backoff: 0 });
    expect((await status(b, A)).status).toBe('degraded');
    expect(b.svc.isWorkerRunning(A)).toBe(false);
  });
  it('unknown message alignment => UI_CHANGED (direction never guessed)', async () => {
    const { b, A } = await connected();
    const page = (b.adapter as any).sessions.get(A).page;
    await page.route('**/direct/t/def222/**', (r: any) =>
      r.fulfill({ contentType: 'text/html', body: '<main><h1>Андрій Мельник</h1><div role="grid"><div role="row"><span data-role="text">hello</span></div></div></main>' }),
    );
    (b.svc as any).sigs.clear();
    await expect(b.svc.syncOnce(A)).rejects.toMatchObject({ code: 'UI_CHANGED' });
  });
});
