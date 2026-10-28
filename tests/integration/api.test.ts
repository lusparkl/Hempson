import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { schema } from '@hepson/database';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { loadConfig } from '../../apps/api/src/config';
import { REDACT_PATHS } from '../../apps/api/src/server';
import { call, makeApp, mockAccount, type TestApp } from '../helpers';

const apps: TestApp[] = [];
const mk = async (...a: Parameters<typeof makeApp>) => {
  const x = await makeApp(...a);
  apps.push(x);
  return x;
};
afterEach(async () => {
  for (const a of apps.splice(0)) {
    await a.close();
    a.cleanup();
  }
});

const conv = async (a: TestApp, id: string, provider = 'mock-thread-olena') => {
  await a.svc.syncOnce(id);
  const r = await call(a, a.admin, 'GET', `/v1/accounts/${id}/conversations`);
  return r.body.items.find((c: any) => c.providerConversationId === provider);
};
const events = async (a: TestApp, id: string, type?: string) =>
  (await call(a, a.admin, 'GET', `/v1/accounts/${id}/events?limit=500`)).body.items.filter((e: any) => !type || e.type === type);
const send = (a: TestApp, id: string, cid: string, text: string, key: string, extra: object = {}) =>
  call(a, a.admin, 'POST', `/v1/accounts/${id}/conversations/${cid}/messages`, { text, idempotencyKey: key, ...extra });

describe('auth & tenant isolation', () => {
  it('requires a key; scoped key cannot touch another account', async () => {
    const a = await mk();
    const A = await mockAccount(a, 'A');
    const B = await mockAccount(a, 'B');
    expect((await call(a, null, 'GET', `/v1/accounts/${A}/status`)).status).toBe(401);
    expect((await call(a, 'hep_bogus', 'GET', `/v1/accounts/${A}/status`)).status).toBe(401);
    const keyA = (await call(a, a.admin, 'POST', `/v1/accounts/${A}/api-keys`, { name: 'a' })).body.key;
    expect((await call(a, keyA, 'GET', `/v1/accounts/${A}/status`)).status).toBe(200);
    for (const [m, u] of [
      ['GET', `/v1/accounts/${B}/status`],
      ['GET', `/v1/accounts/${B}/conversations`],
      ['GET', `/v1/accounts/${B}/events`],
      ['GET', `/v1/accounts/${B}/export`],
      ['POST', `/v1/accounts/${B}/session/pause`],
    ] as const) {
      const r = await call(a, keyA, m, u);
      expect(r.status, u).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN');
    }
    expect((await call(a, keyA, 'POST', '/v1/accounts', { label: 'x', consentConfirmed: false })).status).toBe(403);
    const list = await call(a, keyA, 'GET', '/v1/accounts');
    expect(list.body.items.map((x: any) => x.accountId)).toEqual([A]);
  });
  it("account A cannot read or send via B's conversation ids", async () => {
    const a = await mk();
    const A = await mockAccount(a, 'A');
    const B = await mockAccount(a, 'B');
    const cA = await conv(a, A);
    const cB = await conv(a, B);
    await call(a, a.admin, 'PATCH', `/v1/accounts/${A}/settings`, { outboundEnabled: true });
    await call(a, a.admin, 'PATCH', `/v1/accounts/${B}/settings`, { outboundEnabled: true });
    expect(cA.id).not.toBe(cB.id);
    expect((await call(a, a.admin, 'GET', `/v1/accounts/${A}/conversations/${cB.id}/messages`)).status).toBe(404);
    expect((await send(a, A, cB.id, 'hi', 'cross-key-1')).status).toBe(404);
    expect(a.mock.sendCalls).toBe(0);
    expect((await call(a, a.admin, 'GET', `/v1/accounts/${A}/conversations`)).body.items.every((c: any) => c.accountId === A)).toBe(true);
    // outbox ids are scoped too
    const s = await send(a, B, cB.id, 'hi', 'b-key-0001');
    await a.svc.whenSendsIdle(B);
    expect((await call(a, a.admin, 'GET', `/v1/accounts/${A}/outbox/${s.body.outboxId}`)).status).toBe(404);
    // body accountId is ignored / rejected by schema (strip) — path is the only authority
    const r = await call(a, a.admin, 'POST', `/v1/accounts/${A}/conversations/${cB.id}/messages`, { text: 'x', idempotencyKey: 'body-acc-0001', accountId: B });
    expect(r.status).toBe(404);
  });
});

describe('validation & errors', () => {
  it('consistent error shape', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    const r = await call(a, a.admin, 'GET', '/v1/accounts/not-a-uuid/status');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: 'VALIDATION_ERROR', message: expect.any(String), retryable: false } });
    expect((await call(a, a.admin, 'POST', '/v1/accounts', { label: '' })).status).toBe(400);
    expect((await call(a, a.admin, 'GET', '/v1/nope')).body.error.code).toBe('NOT_FOUND');
    const c = await conv(a, A);
    expect((await call(a, a.admin, 'GET', `/v1/accounts/${A}/conversations?limit=9999`)).status).toBe(400);
    await call(a, a.admin, 'PATCH', `/v1/accounts/${A}/settings`, { outboundEnabled: true });
    expect((await send(a, A, c.id, '   ', 'blank-key-0001')).body.error.code).toBe('VALIDATION_ERROR');
    expect((await send(a, A, c.id, 'x'.repeat(1001), 'long-key-0001')).body.error.code).toBe('VALIDATION_ERROR');
  });
  it('real accounts need consent', async () => {
    const a = await mk();
    const r = await call(a, a.admin, 'POST', '/v1/accounts', { label: 'real', connectorType: 'instagram-browser', consentConfirmed: false });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CONSENT_REQUIRED');
  });
});

describe('new-message events', () => {
  it('duplicate observation emits exactly one message.received', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    await a.svc.syncOnce(A);
    expect(await events(a, A, 'message.received')).toHaveLength(0); // baseline, not "new"
    a.mock.devInjectIncoming(A, 'mock-thread-iryna', 'Є розмір L?');
    await a.svc.syncOnce(A);
    expect(await events(a, A, 'message.received')).toHaveLength(1);
    a.mock.devDuplicateLast(A, 'mock-thread-iryna');
    await a.svc.syncOnce(A);
    await a.svc.syncOnce(A);
    expect(await events(a, A, 'message.received')).toHaveLength(1);
  });
  it('restart does not replay history as new', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    await a.svc.syncOnce(A);
    a.mock.devInjectIncoming(A, 'mock-thread-iryna', 'before restart');
    await a.svc.syncOnce(A);
    const before = (await events(a, A, 'message.received')).length;
    const dir = a.dir;
    await a.close();
    const b = await makeApp({ dir });
    apps.push(b);
    await b.svc.startSession(A, { interactive: false });
    await b.svc.syncOnce(A);
    await b.svc.syncOnce(A);
    expect((await events(b, A, 'message.received')).length).toBe(before);
    const c = (await call(b, b.admin, 'GET', `/v1/accounts/${A}/conversations`)).body.items;
    expect(c.length).toBe(3);
  });
  it('new message after restart IS emitted once', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    await a.svc.syncOnce(A);
    const dir = a.dir;
    await a.close();
    const b = await makeApp({ dir });
    apps.push(b);
    await b.svc.startSession(A, { interactive: false });
    b.mock.devInjectIncoming(A, 'mock-thread-iryna', 'new after restart');
    await b.svc.syncOnce(A);
    await b.svc.syncOnce(A);
    expect(await events(b, A, 'message.received')).toHaveLength(1);
  });
  it('image-only message is an attachment placeholder with null text', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    const c = await conv(a, A, 'mock-thread-andrii');
    const msgs = (await call(a, a.admin, 'GET', `/v1/accounts/${A}/conversations/${c.id}/messages`)).body.items;
    const img = msgs.find((m: any) => m.attachments.length);
    expect(img.text).toBeNull();
    expect(img.attachments[0].kind).toBe('image');
  });
  it('logout surfaces login_required and stops worker', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    await a.svc.syncOnce(A);
    a.mock.devSetStatus(A, 'login_required');
    await expect(a.svc.syncOnce(A)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect((await events(a, A, 'session.login_required')).length).toBeGreaterThan(0);
    expect((await call(a, a.admin, 'GET', `/v1/accounts/${A}/status`)).body.status).toBe('login_required');
  });
});

describe('sending', () => {
  it('outbound disabled by default', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    const c = await conv(a, A);
    const r = await send(a, A, c.id, 'hi', 'disabled-key-1');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('OUTBOUND_DISABLED');
    expect(a.mock.sendCalls).toBe(0);
  });
  it('idempotency: same body different keys send twice; repeated key sends once', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    const c = await conv(a, A);
    await call(a, a.admin, 'PATCH', `/v1/accounts/${A}/settings`, { outboundEnabled: true });
    const r1 = await send(a, A, c.id, 'Так, є', 'idem-key-0001');
    const r2 = await send(a, A, c.id, 'Так, є', 'idem-key-0002');
    const r3 = await send(a, A, c.id, 'Так, є', 'idem-key-0001');
    await a.svc.whenSendsIdle(A);
    expect([r1.status, r2.status, r3.status]).toEqual([202, 202, 202]);
    expect(r3.body.outboxId).toBe(r1.body.outboxId);
    expect(r3.headers['idempotent-replay']).toBe('true');
    expect(r1.body.outboxId).not.toBe(r2.body.outboxId);
    expect(a.mock.sendCalls).toBe(2);
    const conflict = await send(a, A, c.id, 'інший текст', 'idem-key-0001');
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('dryRun validates but does not send', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    const c = await conv(a, A);
    await call(a, a.admin, 'PATCH', `/v1/accounts/${A}/settings`, { outboundEnabled: true });
    const r = await send(a, A, c.id, 'hi', 'dry-key-0001', { dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
    expect(a.mock.sendCalls).toBe(0);
  });
  it('queued, sent, failed, uncertain outcomes; uncertain is never retried', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    const c = await conv(a, A);
    await call(a, a.admin, 'PATCH', `/v1/accounts/${A}/settings`, { outboundEnabled: true });
    a.mock.devPlanSends('sent', 'failed', 'uncertain', 'throw_ui_changed');
    const ids: string[] = [];
    const first = await send(a, A, c.id, 'one', 'out-key-00001');
    expect(first.body.status).toBe('queued'); // 202 returns before the worker runs
    ids.push(first.body.outboxId);
    for (const [i, t] of ['two', 'three', 'four'].entries()) ids.push((await send(a, A, c.id, t, `out-key-0000${i + 2}`)).body.outboxId);
    await a.svc.whenSendsIdle(A);
    const st = [] as any[];
    for (const id of ids) st.push((await call(a, a.admin, 'GET', `/v1/accounts/${A}/outbox/${id}`)).body);
    expect(st.map((s) => s.status)).toEqual(['sent', 'failed', 'uncertain', 'failed']);
    expect(st[2].needsReview).toBe(true);
    expect(st[3].errorCode).toBe('UI_CHANGED');
    expect(a.mock.sendCalls).toBe(4); // one attempt each, no retry
    await a.svc.syncOnce(A);
    expect(a.mock.sendCalls).toBe(4);
    const rev = await call(a, a.admin, 'POST', `/v1/accounts/${A}/outbox/${ids[2]}/review`);
    expect(rev.body.needsReview).toBe(false);
    expect(a.mock.sendCalls).toBe(4);
    const types = (await events(a, A)).map((e: any) => e.type);
    expect(types.filter((t: string) => t === 'message.sent')).toHaveLength(1);
  });
  it('crash recovery: sending => uncertain, queued => failed, never auto-sent', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    const c = await conv(a, A);
    const r1 = a.store.createOutbox(A, { conversationId: c.id, idempotencyKey: 'crash-key-001', body: 'x', bodyHash: 'h', dryRun: false }).row;
    const r2 = a.store.createOutbox(A, { conversationId: c.id, idempotencyKey: 'crash-key-002', body: 'y', bodyHash: 'h2', dryRun: false }).row;
    a.store.transitionOutbox(A, r1.id, ['queued'], 'sending');
    a.svc.recoverInterruptedSends();
    expect(a.store.getOutbox(A, r1.id)!.status).toBe('uncertain');
    expect(a.store.getOutbox(A, r2.id)!.status).toBe('failed');
    expect(a.mock.sendCalls).toBe(0);
  });
  it('uncertain send resolves to sent only if provider later shows it (no duplicate message)', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    const c = await conv(a, A);
    await call(a, a.admin, 'PATCH', `/v1/accounts/${A}/settings`, { outboundEnabled: true });
    a.mock.devPlanSends('uncertain');
    const r = await send(a, A, c.id, 'можливо дійшло', 'resolve-key-01');
    await a.svc.whenSendsIdle(A);
    // message really went through on the provider side:
    const thread = (a.mock as any).accounts.get(A).threads.get('mock-thread-olena');
    thread.messages.push({ providerMessageId: 'late-1', direction: 'outgoing', text: 'можливо дійшло', attachments: [], sentAt: new Date().toISOString(), ordinal: 99 });
    thread.conv.latestMessageAt = new Date(Date.now() + 1000).toISOString();
    await a.svc.syncOnce(A);
    expect((await call(a, a.admin, 'GET', `/v1/accounts/${A}/outbox/${r.body.outboxId}`)).body.status).toBe('sent');
    const msgs = (await call(a, a.admin, 'GET', `/v1/accounts/${A}/conversations/${c.id}/messages`)).body.items.filter((m: any) => m.text === 'можливо дійшло');
    expect(msgs).toHaveLength(1);
  });
});

describe('events', () => {
  it('replay with afterSequence is ordered and gapless', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    await a.svc.syncOnce(A);
    for (let i = 0; i < 3; i++) {
      a.mock.devInjectIncoming(A, 'mock-thread-iryna', `msg ${i}`);
      await a.svc.syncOnce(A);
    }
    const all = (await call(a, a.admin, 'GET', `/v1/accounts/${A}/events`)).body.items;
    expect(all.map((e: any) => e.sequence)).toEqual(all.map((_: any, i: number) => i + 1));
    const tail = (await call(a, a.admin, 'GET', `/v1/accounts/${A}/events?afterSequence=${all[1].sequence}`)).body;
    expect(tail.items[0].sequence).toBe(all[1].sequence + 1);
    for (const e of all) expect(e).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), accountId: A, occurredAt: expect.any(String), payload: expect.any(Object) });
  });
  it('sequences are per-account', async () => {
    const a = await mk();
    const A = await mockAccount(a, 'A');
    const B = await mockAccount(a, 'B');
    expect((await events(a, A))[0].sequence).toBe(1);
    expect((await events(a, B))[0].sequence).toBe(1);
  });
});

describe('persistence & privacy', () => {
  it('migrations are idempotent and schema has no secret columns', async () => {
    const a = await mk();
    const { runMigrations } = await import('@hepson/database');
    runMigrations(a.handle);
    runMigrations(a.handle);
    const tables = a.handle.raw
      .prepare("select name from sqlite_master where type='table'")
      .all()
      .map((r: any) => r.name);
    for (const t of ['store_accounts', 'api_keys', 'conversations', 'messages', 'outbox', 'events', 'connector_state']) expect(tables).toContain(t);
    const bad = /cookie|password|passwd|secret|totp|2fa|session_?id|access_?token|profile_?bytes|storage_?state/i;
    for (const t of Object.values(schema)) {
      for (const col of Object.values(getTableColumns(t as any))) expect((col as any).name, `${getTableName(t as any)}.${(col as any).name}`).not.toMatch(bad);
    }
  });
  it('stores only a hash of API keys', async () => {
    const a = await mk();
    const rows = a.handle.raw.prepare('select hashed_key from api_keys').all() as any[];
    expect(rows.every((r) => !r.hashed_key.startsWith('hep_') && r.hashed_key.length === 64)).toBe(true);
    expect(rows.some((r) => r.hashed_key === a.admin)).toBe(false);
  });
  it('export and status never expose profile data; HTTP does not serve data dir', async () => {
    const a = await mk();
    const A = await mockAccount(a);
    await conv(a, A);
    const exp = JSON.stringify((await call(a, a.admin, 'GET', `/v1/accounts/${A}/export`)).body);
    const status = JSON.stringify((await call(a, a.admin, 'GET', `/v1/accounts/${A}/status`)).body);
    for (const s of [exp, status]) {
      expect(s).not.toContain(a.dir);
      expect(s).not.toMatch(/profiles|cookie/i);
    }
    for (const u of [`/profiles/${A}/Default/Cookies`, `/v1/profiles/${A}`, '/hepson.db', '/static/../hepson.db']) expect((await call(a, a.admin, 'GET', u)).status).toBe(404);
  });
  it('default data dir is outside the repo and repo ignores profile-like paths', () => {
    const cfg = loadConfig({} as any);
    const repo = path.resolve(import.meta.dirname, '../..');
    expect(path.relative(repo, cfg.dataDir).startsWith('..')).toBe(true);
    const gi = readFileSync(path.join(repo, '.gitignore'), 'utf8');
    for (const p of ['profiles/', '*.db', '.hepson/']) expect(gi).toContain(p);
    expect(existsSync(path.join(repo, 'profiles'))).toBe(false);
  });
  it('delete data & export & retention', async () => {
    const a = await mk();
    const A = await mockAccount(a, 'shop-x');
    await conv(a, A);
    expect((await call(a, a.admin, 'DELETE', `/v1/accounts/${A}/data`, { confirmLabel: 'wrong' })).status).toBe(400);
    expect((await call(a, a.admin, 'DELETE', `/v1/accounts/${A}/data`, { confirmLabel: 'shop-x' })).status).toBe(200);
    expect((await call(a, a.admin, 'GET', `/v1/accounts/${A}/conversations`)).body.items).toHaveLength(0);
    await a.svc.syncOnce(A);
    expect(a.store.purgeOlderThan(A, 30).messages).toBe(0);
    expect(a.store.purgeOlderThan(A, -1).messages).toBeGreaterThan(0);
  });
  it('log redaction removes auth headers, cookies, message text', () => {
    let out = '';
    const l = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, {
      write: (s: string) => {
        out += s;
      },
    } as any);
    l.info({ req: { headers: { authorization: 'Bearer hep_SECRET', cookie: 'sessionid=abc' } }, msg2: 1, data: { text: 'private customer text', cookie: 'sessionid=zzz' } }, 'x');
    expect(out).not.toMatch(/hep_SECRET|sessionid|private customer/);
  });
  it('OpenAPI is served and covers the minimum routes', async () => {
    const a = await mk();
    const spec = (await call(a, null, 'GET', '/v1/openapi.json')).body;
    for (const p of [
      '/v1/accounts',
      '/v1/accounts/{accountId}/status',
      '/v1/accounts/{accountId}/session/profile',
      '/v1/accounts/{accountId}/conversations/{conversationId}/messages',
      '/v1/accounts/{accountId}/events/stream',
    ])
      expect(spec.paths[p], p).toBeTruthy();
  });
});
