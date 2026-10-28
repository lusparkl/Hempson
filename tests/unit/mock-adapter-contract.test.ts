import { describe, expect, it } from 'vitest';
import { ConnectorError, type MessagingAdapter } from '@hepson/connector-core';
import { MockAdapter } from '@hepson/mock-adapter';

const A = '11111111-1111-4111-8111-111111111111';
const ctx = { expectedHandle: null, interactiveLogin: false };

/** Reusable contract checks: any MessagingAdapter must satisfy these. */
export async function adapterContract(make: () => MessagingAdapter) {
  const ad = make();
  expect(await ad.getStatus(A)).toBe('disconnected');
  await expect(ad.listConversations(A)).rejects.toBeInstanceOf(ConnectorError);
  expect(await ad.connect(A, ctx)).toBe('connected');
  const convs = await ad.listConversations(A, { limit: 2 });
  expect(convs.items.length).toBe(2);
  const c = convs.items.find((x) => x.providerConversationId === 'mock-thread-olena') ?? (await ad.listConversations(A)).items.find((x) => x.providerConversationId === 'mock-thread-olena')!;
  expect(c.providerConversationId).toBeTruthy();
  const page = await ad.listMessages(A, c.providerConversationId, { limit: 1 });
  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).not.toBeNull();
  const older = await ad.listMessages(A, c.providerConversationId, { limit: 50, cursor: page.nextCursor! });
  expect(older.items.length).toBeGreaterThan(0);
  const r = await ad.sendText(A, c.providerConversationId, 'hello', 'k-1', { title: c.title });
  expect(r.status).toBe('sent');
  await expect(ad.sendText(A, c.providerConversationId, 'x', 'k-2', { title: 'WRONG TITLE' })).rejects.toMatchObject({ code: 'UI_CHANGED' });
  await ad.disconnect(A);
  expect(await ad.getStatus(A)).toBe('disconnected');
}

describe('MockAdapter satisfies the MessagingAdapter contract', () => {
  it('contract', async () => adapterContract(() => new MockAdapter()));
  it('status listener fires on logout', async () => {
    const m = new MockAdapter();
    const seen: string[] = [];
    m.onStatusChange((_id, s) => seen.push(s));
    await m.connect(A, ctx);
    m.devSetStatus(A, 'login_required');
    await expect(m.listConversations(A)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect(seen).toEqual(['connected', 'login_required']);
  });
});
