import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTAGRAM_CHANNEL, Keyring } from '@hepson/database';
import { makeApp, type TestApp } from '../helpers';
import { ScriptedLlm } from '../fixtures/scripted-llm';

const IG = '17841400000000001';
const CUSTOMER = '5551230001';
const SECRET = 'test-app-secret';
let a: TestApp;
let shopId: string;
let polledMessages: unknown[];

beforeEach(async () => {
  polledMessages = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const body = new URL(String(input)).pathname.endsWith('/conversations')
      ? { data: [{ id: 'thread', messages: { data: polledMessages } }] }
      : { name: 'Customer', username: 'customer' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  a = await makeApp({
    publicUrl: 'https://hepson.example',
    metaAppId: 'test-app',
    metaConfigId: 'test-config',
    metaAppSecret: SECRET,
    metaVerifyToken: 'test-verify',
    keyring: new Keyring(1, randomBytes(32)),
    llm: new ScriptedLlm([]),
    fetchImpl,
  });
  shopId = a.shops.create({ name: 'Shop', slug: 'recovery-shop' }).id;
  a.igRepo.upsertChannel(shopId, { igUserId: IG, username: 'shop', tokenExpiresAt: null });
  a.vault.save(shopId, 'instagram', 'test-token');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await a?.close();
  a?.cleanup();
});

const event = (mid: string, text = 'Hello') => ({ sender: { id: CUSTOMER }, recipient: { id: IG }, timestamp: Date.now(), message: { mid, text } });
async function webhook(...events: ReturnType<typeof event>[]) {
  const raw = JSON.stringify({ object: 'instagram', entry: [{ id: IG, messaging: events }] });
  const res = await a.app.inject({
    method: 'POST',
    url: '/webhooks/instagram',
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` },
  });
  await a.ig.whenIdle();
  return res;
}
const messages = () => {
  const conv = a.conversations.findConversationByExternal(shopId, INSTAGRAM_CHANNEL, CUSTOMER);
  return conv ? a.conversations.listMessages(shopId, conv.conversation.id).items : [];
};
const polled = (id: string, ms: number, text = 'Hello') => ({
  id,
  created_time: new Date(ms).toISOString(),
  from: { id: CUSTOMER },
  to: { data: [{ id: IG }] },
  message: text,
});

describe('Instagram ingestion recovery', () => {
  it('retries a failed write while retaining and deduplicating other events in the batch', async () => {
    const trigger = vi.spyOn(a.salesAgent!, 'trigger');
    vi.spyOn(a.conversations, 'ingestMessage').mockImplementationOnce(() => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });
    const batch = [event('retry'), event('stored')];
    expect((await webhook(...batch)).statusCode).toBe(503);
    expect(messages().map((m) => m.externalId)).toEqual(['stored']);
    expect((await webhook(...batch)).statusCode).toBe(200);
    expect(messages().map((m) => m.externalId)).toEqual(['stored', 'retry']);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('acknowledges permanently invalid messages and still ingests the valid events', async () => {
    expect((await webhook(event('invalid', 'x'.repeat(10_001)), event('valid'))).statusCode).toBe(200);
    expect(messages().map((m) => m.externalId)).toEqual(['valid']);
  });

  it('rolls back a message if synchronous agent dispatch fails, allowing its retry', async () => {
    const trigger = vi.spyOn(a.salesAgent!, 'trigger').mockImplementationOnce(() => {
      throw new Error('dispatch unavailable');
    });
    expect((await webhook(event('dispatch'))).statusCode).toBe(503);
    expect(messages()).toEqual([]);
    expect((await webhook(event('dispatch'))).statusCode).toBe(200);
    expect(messages().map((m) => m.externalId)).toEqual(['dispatch']);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('the first poll recovers messages since connection without importing earlier history', async () => {
    const connectedAt = Date.now() - 5_000;
    a.handle.raw.prepare('update instagram_channels set connected_at = ? where shop_id = ?').run(new Date(connectedAt).toISOString(), shopId);
    polledMessages = [polled('old', connectedAt - 1_000), polled('new', connectedAt + 1_000)];
    expect(await a.ig.pollOnce()).toBe(1);
    expect(messages().map((m) => m.externalId)).toEqual(['new']);
  });

  it('preserves the polling cursor on a failed write and retries without duplicating successful writes', async () => {
    const baseline = Date.now() - 10_000;
    const cursor = new Date(baseline).toISOString();
    a.igRepo.setPolledUntil(shopId, cursor);
    polledMessages = [polled('retry', baseline + 1_000), polled('stored', baseline + 2_000)];
    const trigger = vi.spyOn(a.salesAgent!, 'trigger');
    vi.spyOn(a.conversations, 'ingestMessage').mockImplementationOnce(() => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });
    expect(await a.ig.pollOnce()).toBe(1);
    expect(a.igRepo.getChannel(shopId)!.polledUntil).toBe(cursor);
    expect(await a.ig.pollOnce()).toBe(1);
    expect(messages().map((m) => m.externalId)).toEqual(['stored', 'retry']);
    expect(trigger).toHaveBeenCalledTimes(2);
    expect(a.igRepo.getChannel(shopId)!.polledUntil).toBe(new Date(baseline + 2_000).toISOString());
  });

  it('recovers a newly visible message at the same timestamp as the polling cursor', async () => {
    const time = Date.now() - 1_000;
    a.igRepo.setPolledUntil(shopId, new Date(time - 1_000).toISOString());
    polledMessages = [polled('first', time)];
    expect(await a.ig.pollOnce()).toBe(1);
    polledMessages.push(polled('same-time', time));
    expect(await a.ig.pollOnce()).toBe(1);
    expect(await a.ig.pollOnce()).toBe(0);
    expect(messages().map((m) => m.externalId)).toEqual(['first', 'same-time']);
  });

  it('keeps the polling cursor when reconnecting the same account and resets it when switching accounts', () => {
    const cursor = new Date(Date.now() - 1_000).toISOString();
    a.igRepo.setPolledUntil(shopId, cursor);
    a.igRepo.upsertChannel(shopId, { igUserId: IG, username: 'shop', tokenExpiresAt: null });
    expect(a.igRepo.getChannel(shopId)!.polledUntil).toBe(cursor);
    a.igRepo.upsertChannel(shopId, { igUserId: '17841400000000002', username: 'another-shop', tokenExpiresAt: null });
    expect(a.igRepo.getChannel(shopId)!.polledUntil).toBeNull();
  });
});
