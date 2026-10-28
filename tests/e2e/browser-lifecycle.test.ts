import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfileLock, profileDir } from '@hepson/instagram-browser';
import { call } from '../helpers';
import { FakeInstagram, seedThreads } from '../fixtures/fake-instagram';
import { bootApi, createReal, eventTypes, ownerLogsIn, profileFiles, profilePath, sessionOf, status, until, type Booted } from './helpers';

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
  fake.addUser('shop_b', seedThreads());
});
afterEach(async () => {
  for (const b of live.splice(0)) {
    await b.close().catch(() => undefined);
  }
});
const boot = async (dir?: string) => {
  const b = await bootApi(fake, dir);
  live.push(b);
  return b;
};
const restart = async (b: Booted) => {
  const dir = b.dir;
  await b.close();
  live.splice(live.indexOf(b), 1);
  return boot(dir);
};

async function firstLogin(b: Booted, label: string, handle: string) {
  const id = await createReal(b, label, handle);
  const r = await call(b, b.admin, 'POST', `/v1/accounts/${id}/session/start`, { interactive: true });
  expect(r.body.status).toBe('login_required');
  expect(r.body.awaitingOwnerAction).toBe(true);
  await ownerLogsIn(b, id, fake, handle);
  await until(async () => (await status(b, id)).status === 'connected', 15_000, 'connected after owner login');
  return id;
}

describe('persistent login (real Chromium, local fake Instagram)', () => {
  it('ACCEPTANCE: owner logs in once; after full API restart the saved profile reconnects with no login', async () => {
    const b1 = await boot();
    const A = await firstLogin(b1, 'shop-a', 'shop_a');
    expect((await status(b1, A)).restoredFromSavedLogin).toBe(false);
    await b1.svc.syncOnce(A);
    const before = (await eventTypes(b1, A)).filter((t) => t === 'message.received').length;
    const dir = profileDir(b1.dir, A);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const loginsBefore = (await eventTypes(b1, A)).filter((t) => t === 'session.login_required').length;

    const b2 = await restart(b1); // process "restart": new DB handle, new adapter, new Chromium
    await b2.svc.autostart(); // boot path: no owner interaction, no interactive flag
    const st = await status(b2, A);
    expect(st.status).toBe('connected');
    expect(st.restoredFromSavedLogin).toBe(true);
    expect((await eventTypes(b2, A)).filter((t) => t === 'session.login_required').length).toBe(loginsBefore);
    await b2.svc.syncOnce(A);
    await b2.svc.syncOnce(A);
    expect((await eventTypes(b2, A)).filter((t) => t === 'message.received').length).toBe(before); // no history replay
    const convs = (await call(b2, b2.admin, 'GET', `/v1/accounts/${A}/conversations`)).body.items;
    expect(convs).toHaveLength(2);
  });

  it('expired/revoked session => login_required; profile NOT deleted; no credential automation', async () => {
    const b1 = await boot();
    const A = await firstLogin(b1, 'shop-a', 'shop_a');
    const filesBefore = profileFiles(b1.dir, A);
    expect(filesBefore).toBeGreaterThan(0);
    fake.revokeAll();
    const b2 = await restart(b1);
    await b2.svc.autostart();
    const st = await status(b2, A);
    expect(st.status).toBe('login_required');
    expect(st.statusMessage).toMatch(/Re-login required/);
    expect(profileFiles(b2.dir, A)).toBeGreaterThan(0);
    expect(sessionOf(b2, A)).toBeUndefined(); // non-interactive: window closed, nothing left running
    expect(b2.svc.isWorkerRunning(A)).toBe(false);
    // owner can re-login interactively, and then sync works again
    fake.sessions.clear();
    await call(b2, b2.admin, 'POST', `/v1/accounts/${A}/session/start`, { interactive: true });
    await ownerLogsIn(b2, A, fake, 'shop_a');
    await until(async () => (await status(b2, A)).status === 'connected', 15_000);
  });

  it('wrong-account profile fails closed (IDENTITY_MISMATCH), nothing synced', async () => {
    const b1 = await boot();
    const A = await firstLogin(b1, 'shop-a', 'shop_a');
    b1.store.updateAccount(A, { expectedInstagramHandle: 'someone_else' }); // profile now "belongs" to another handle
    await b1.svc.syncOnce(A);
    const syncedAt = b1.store.getState(A)?.lastSyncAt;
    const b2 = await restart(b1);
    const r = await call(b2, b2.admin, 'POST', `/v1/accounts/${A}/session/start`, { interactive: false });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IDENTITY_MISMATCH');
    expect((await status(b2, A)).status).toBe('failed');
    expect(b2.svc.isWorkerRunning(A)).toBe(false);
    expect(b2.store.getState(A)?.lastSyncAt).toBe(syncedAt); // no sync happened under the wrong identity
    expect(profileFiles(b2.dir, A)).toBeGreaterThan(0); // never auto-deleted
  });

  it('owner logging in as the WRONG account in the window is rejected', async () => {
    const b = await boot();
    const A = await createReal(b, 'shop-a', 'shop_a');
    await call(b, b.admin, 'POST', `/v1/accounts/${A}/session/start`, { interactive: true });
    await ownerLogsIn(b, A, fake, 'shop_b');
    await until(async () => (await status(b, A)).status === 'failed', 15_000);
    expect((await status(b, A)).lastErrorCode).toBe('IDENTITY_MISMATCH');
    expect(b.svc.isWorkerRunning(A)).toBe(false);
  });

  it('A and B have separate profiles; B does not inherit A login; pause/disconnect keep profiles; forget deletes only A', async () => {
    const b = await boot();
    const A = await firstLogin(b, 'shop-a', 'shop_a');
    const B = await firstLogin(b, 'shop-b', 'shop_b');
    expect(profilePath(b.dir, A)).not.toBe(profilePath(b.dir, B));
    await b.svc.syncOnce(A);
    await b.svc.syncOnce(B);
    // pause A: B unaffected, both profiles survive
    await call(b, b.admin, 'POST', `/v1/accounts/${A}/session/pause`);
    expect((await status(b, A)).status).toBe('disconnected');
    expect((await status(b, B)).status).toBe('connected');
    expect(profileFiles(b.dir, A)).toBeGreaterThan(0);
    expect(profileFiles(b.dir, B)).toBeGreaterThan(0);
    // resume A from saved login, no owner action
    await call(b, b.admin, 'POST', `/v1/accounts/${A}/session/resume`);
    expect(await status(b, A)).toMatchObject({ status: 'connected', restoredFromSavedLogin: true });
    await call(b, b.admin, 'POST', `/v1/accounts/${A}/session/disconnect`);
    expect(profileFiles(b.dir, A)).toBeGreaterThan(0);
    // forget requires the exact label
    expect((await call(b, b.admin, 'DELETE', `/v1/accounts/${A}/session/profile`, { confirmLabel: 'nope' })).status).toBe(400);
    expect(profileFiles(b.dir, A)).toBeGreaterThan(0);
    expect((await call(b, b.admin, 'DELETE', `/v1/accounts/${A}/session/profile`, { confirmLabel: 'shop-a' })).status).toBe(200);
    expect(existsSync(profilePath(b.dir, A))).toBe(false);
    expect((await status(b, A)).status).toBe('login_required');
    expect(profileFiles(b.dir, B)).toBeGreaterThan(0);
    expect((await status(b, B)).status).toBe('connected');
    // a brand-new account C with no login must not inherit A's/B's cookies
    const C = await createReal(b, 'shop-c');
    const rc = await call(b, b.admin, 'POST', `/v1/accounts/${C}/session/start`, { interactive: false });
    expect(rc.body.status).toBe('login_required');
  });

  it('checkpoint: stops worker, asks owner; no bypass', async () => {
    const b = await boot();
    const A = await firstLogin(b, 'shop-a', 'shop_a');
    fake.mode.checkpoint = true;
    await expect(b.svc.syncOnce(A)).rejects.toMatchObject({ code: 'CHECKPOINT_REQUIRED' });
    await call(b, b.admin, 'POST', `/v1/accounts/${A}/session/pause`);
    const r = await call(b, b.admin, 'POST', `/v1/accounts/${A}/session/resume`);
    expect(r.body.status).toBe('checkpoint_required');
    expect(await eventTypes(b, A)).toContain('session.checkpoint_required');
  });

  it('logout mid-run surfaces login_required', async () => {
    const b = await boot();
    const A = await firstLogin(b, 'shop-a', 'shop_a');
    await b.svc.syncOnce(A);
    fake.revokeAll();
    (b.svc as any).sigs.clear();
    await expect(b.svc.syncOnce(A)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect((await status(b, A)).status).toBe('login_required');
    expect(await eventTypes(b, A)).toContain('session.login_required');
  });

  it('browser crash: degraded, then auto-reconnects from the same profile without login', async () => {
    const b = await boot();
    const A = await firstLogin(b, 'shop-a', 'shop_a');
    await sessionOf(b, A)!.context.close(); // unexpected close (not via adapter)
    await until(async () => (await status(b, A)).status === 'degraded' || (await status(b, A)).status === 'connected', 5000);
    await until(
      async () => {
        const s = await status(b, A);
        return s.status === 'connected' && !!sessionOf(b, A);
      },
      20_000,
      'reconnect',
    );
    expect(await eventTypes(b, A)).toContain('connector.degraded');
    expect((await status(b, A)).restoredFromSavedLogin).toBe(true);
  });
});

describe('ProfileLock', () => {
  it('refuses a live foreign pid; replaces a stale lock without touching profile', () => {
    const dir = path.join(process.env.TMPDIR ?? '/tmp', `hep-lock-${Date.now()}`);
    const id = '33333333-3333-4333-8333-333333333333';
    mkdirSync(path.join(dir, 'locks'), { recursive: true });
    mkdirSync(profileDir(dir, id), { recursive: true });
    writeFileSync(path.join(profileDir(dir, id), 'Cookies'), 'x');
    const lockFile = path.join(dir, 'locks', `${id}.lock`);
    writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
    expect(() => new ProfileLock(dir).acquire(id)).toThrowError(/in use/);
    const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))']);
    writeFileSync(lockFile, JSON.stringify({ pid: Number(dead.stdout.toString()) }));
    const l = new ProfileLock(dir);
    l.acquire(id);
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
    expect(existsSync(path.join(profileDir(dir, id), 'Cookies'))).toBe(true);
    l.release(id);
    expect(existsSync(lockFile)).toBe(false);
  });
  it('rejects non-UUID account ids (no path traversal)', () => {
    expect(() => profileDir('/tmp/x', '../../etc')).toThrow();
  });
});
