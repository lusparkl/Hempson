import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, call, type TestApp } from '../helpers';
import { hashPassword, verifyPassword } from '../../apps/api/src/auth/password';
import { LoginThrottle } from '../../apps/api/src/auth/throttle';

let a: TestApp;
beforeEach(async () => {
  a = await makeApp();
});
afterEach(async () => {
  await a.close();
  a.cleanup();
});

const PW = 'correct horse battery';
async function signup(email: string, name = 'User') {
  const r = await call(a, null, 'POST', '/v1/auth/register', { email, displayName: name, password: PW });
  expect(r.status).toBe(201);
  const l = await call(a, null, 'POST', '/v1/auth/login', { email, password: PW });
  expect(l.status).toBe(200);
  return { token: l.body.token as string, userId: r.body.userId as string };
}
const mkShop = async (token: string, slug: string) => {
  const r = await call(a, token, 'POST', '/v1/shops', { name: slug.toUpperCase(), slug });
  expect(r.status).toBe(201);
  return r.body.shopId as string;
};

describe('password + throttle', () => {
  it('hashes with salt and verifies', async () => {
    const h = await hashPassword('secret-password');
    expect(h).not.toContain('secret-password');
    expect(h).not.toBe(await hashPassword('secret-password'));
    expect(await verifyPassword('secret-password', h)).toBe(true);
    expect(await verifyPassword('wrong-password', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
  it('blocks after max failures within window, then expires', () => {
    let now = 0;
    const t = new LoginThrottle(3, 1000, () => now);
    for (let i = 0; i < 3; i++) t.fail('k');
    expect(t.blocked('k')).toBe(true);
    expect(t.blocked('other')).toBe(false);
    now = 1001;
    expect(t.blocked('k')).toBe(false);
  });
});

describe('registration and login', () => {
  it('registers, never exposes the hash, rejects duplicates and weak input', async () => {
    const r = await call(a, null, 'POST', '/v1/auth/register', { email: 'Own@Example.com', displayName: 'Own', password: PW });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email: 'own@example.com', displayName: 'Own' });
    expect(JSON.stringify(r.body)).not.toMatch(/hash|scrypt/i);
    expect(a.auth.getUserByEmail('own@example.com')!.passwordHash).toMatch(/^scrypt\$/);
    expect((await call(a, null, 'POST', '/v1/auth/register', { email: 'own@example.com', displayName: 'x', password: PW })).status).toBe(400);
    expect((await call(a, null, 'POST', '/v1/auth/register', { email: 'bad', displayName: 'x', password: PW })).status).toBe(400);
    expect((await call(a, null, 'POST', '/v1/auth/register', { email: 'b@example.com', displayName: 'x', password: 'short' })).status).toBe(400);
  });

  it('login gives a token only for right credentials; same error for unknown email', async () => {
    await signup('u@example.com');
    const bad = await call(a, null, 'POST', '/v1/auth/login', { email: 'u@example.com', password: 'wrong-password-1' });
    const unknown = await call(a, null, 'POST', '/v1/auth/login', { email: 'nobody@example.com', password: 'wrong-password-1' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body).toEqual(unknown.body);
  });

  it('stores only a hash of the session token', async () => {
    const { token } = await signup('u@example.com');
    expect(token).toMatch(/^hsu_/);
    const rows = a.handle.raw.prepare('select hashed_token from user_sessions').all() as Array<{ hashed_token: string }>;
    expect(rows.map((r) => r.hashed_token)).not.toContain(token);
  });

  it('throttles repeated failed logins', async () => {
    await signup('u@example.com');
    for (let i = 0; i < 5; i++) expect((await call(a, null, 'POST', '/v1/auth/login', { email: 'u@example.com', password: 'wrong-password-1' })).status).toBe(401);
    expect((await call(a, null, 'POST', '/v1/auth/login', { email: 'u@example.com', password: PW })).status).toBe(429);
  });

  it('logout revokes the session; expired sessions are rejected', async () => {
    const { token, userId } = await signup('u@example.com');
    expect((await call(a, token, 'GET', '/v1/auth/me')).body.user.userId).toBe(userId);
    expect((await call(a, token, 'POST', '/v1/auth/logout')).status).toBe(200);
    expect((await call(a, token, 'GET', '/v1/auth/me')).status).toBe(401);
    const expired = a.auth.createSession(userId, -1000).token;
    expect((await call(a, expired, 'GET', '/v1/auth/me')).status).toBe(401);
  });

  it('registration can be disabled', async () => {
    await a.close();
    a.cleanup();
    a = await makeApp({ allowRegistration: false });
    expect((await call(a, null, 'POST', '/v1/auth/register', { email: 'u@example.com', displayName: 'U', password: PW })).status).toBe(403);
  });
});

describe('credential separation', () => {
  it('requires a session for shop routes; connector API keys and junk tokens are rejected', async () => {
    expect((await call(a, null, 'GET', '/v1/shops')).status).toBe(401);
    expect((await call(a, a.admin, 'GET', '/v1/shops')).status).toBe(401);
    expect((await call(a, 'hsu_junk', 'GET', '/v1/shops')).status).toBe(401);
  });
  it('session tokens do not open connector routes', async () => {
    const { token } = await signup('u@example.com');
    expect((await call(a, token, 'GET', '/v1/accounts')).status).toBe(401);
  });
});

describe('shops and memberships', () => {
  it('creator becomes owner; list shows only own shops', async () => {
    const u1 = await signup('u1@example.com');
    const u2 = await signup('u2@example.com');
    const s1 = await mkShop(u1.token, 'shop-one');
    await mkShop(u2.token, 'shop-two');
    const list = await call(a, u1.token, 'GET', '/v1/shops');
    expect(list.body.map((s: { shopId: string }) => s.shopId)).toEqual([s1]);
    expect(list.body[0]).toMatchObject({ role: 'owner', defaultCurrency: 'UAH', defaultLanguage: 'uk' });
    expect((await call(a, u1.token, 'GET', '/v1/auth/me')).body.shops).toHaveLength(1);
  });

  it('invalid or duplicate shop creation leaves no orphan shop', async () => {
    const u = await signup('u@example.com');
    await mkShop(u.token, 'dup');
    expect((await call(a, u.token, 'POST', '/v1/shops', { name: 'x', slug: 'dup' })).status).toBe(400);
    expect((await call(a, u.token, 'POST', '/v1/shops', { name: 'x', slug: 'BAD SLUG' })).status).toBe(400);
    expect(a.shops.list()).toHaveLength(1);
  });

  it('cross-shop access is denied as 404 on every shop route', async () => {
    const u1 = await signup('u1@example.com');
    const u2 = await signup('u2@example.com');
    const s1 = await mkShop(u1.token, 'shop-one');
    const base = `/v1/shops/${s1}`;
    const attempts: Array<[Parameters<typeof call>[2], string, unknown?]> = [
      ['GET', base],
      ['PATCH', base, { name: 'hijack' }],
      ['GET', `${base}/members`],
      ['POST', `${base}/members`, { email: 'u2@example.com', role: 'owner' }],
      ['PATCH', `${base}/members/${u1.userId}`, { role: 'manager' }],
      ['DELETE', `${base}/members/${u1.userId}`],
    ];
    for (const [m, url, body] of attempts) expect((await call(a, u2.token, m, url, body)).status, `${m} ${url}`).toBe(404);
    expect(a.shops.get(s1)!.name).toBe('SHOP-ONE');
    expect(a.auth.listMembers(s1)).toHaveLength(1);
  });

  it('member of shop A cannot touch shop B even with own valid shop', async () => {
    const u1 = await signup('u1@example.com');
    const u2 = await signup('u2@example.com');
    const s1 = await mkShop(u1.token, 'shop-one');
    await mkShop(u2.token, 'shop-two');
    expect((await call(a, u2.token, 'PATCH', `/v1/shops/${s1}`, { name: 'x' })).status).toBe(404);
  });

  it('owner manages members; manager can read but not mutate', async () => {
    const owner = await signup('owner@example.com');
    const mgr = await signup('mgr@example.com');
    const shop = await mkShop(owner.token, 'shop-one');
    const add = await call(a, owner.token, 'POST', `/v1/shops/${shop}/members`, { email: 'MGR@example.com', role: 'manager' });
    expect(add.status).toBe(201);
    expect((await call(a, owner.token, 'POST', `/v1/shops/${shop}/members`, { email: 'mgr@example.com', role: 'manager' })).status).toBe(400);
    expect((await call(a, owner.token, 'POST', `/v1/shops/${shop}/members`, { email: 'ghost@example.com', role: 'manager' })).status).toBe(404);

    expect((await call(a, mgr.token, 'GET', `/v1/shops/${shop}`)).body.role).toBe('manager');
    expect((await call(a, mgr.token, 'GET', `/v1/shops/${shop}/members`)).body).toHaveLength(2);
    expect((await call(a, mgr.token, 'PATCH', `/v1/shops/${shop}`, { name: 'x' })).status).toBe(403);
    expect((await call(a, mgr.token, 'POST', `/v1/shops/${shop}/members`, { email: 'owner@example.com', role: 'owner' })).status).toBe(403);
    expect((await call(a, mgr.token, 'PATCH', `/v1/shops/${shop}/members/${mgr.userId}`, { role: 'owner' })).status).toBe(403);
    expect((await call(a, mgr.token, 'DELETE', `/v1/shops/${shop}/members/${owner.userId}`)).status).toBe(403);
    expect(a.auth.getMembership(shop, mgr.userId)!.role).toBe('manager');

    expect((await call(a, owner.token, 'PATCH', `/v1/shops/${shop}`, { name: 'Renamed', defaultLanguage: 'pl' })).body).toMatchObject({ name: 'Renamed', defaultLanguage: 'pl' });
    expect((await call(a, owner.token, 'PATCH', `/v1/shops/${shop}/members/${mgr.userId}`, { role: 'owner' })).body.role).toBe('owner');
  });

  it('protects the last owner and lets a manager leave', async () => {
    const owner = await signup('owner@example.com');
    const mgr = await signup('mgr@example.com');
    const shop = await mkShop(owner.token, 'shop-one');
    await call(a, owner.token, 'POST', `/v1/shops/${shop}/members`, { email: 'mgr@example.com', role: 'manager' });
    expect((await call(a, owner.token, 'PATCH', `/v1/shops/${shop}/members/${owner.userId}`, { role: 'manager' })).status).toBe(400);
    expect((await call(a, owner.token, 'DELETE', `/v1/shops/${shop}/members/${owner.userId}`)).status).toBe(400);
    expect(a.auth.getMembership(shop, owner.userId)!.role).toBe('owner');
    expect((await call(a, mgr.token, 'DELETE', `/v1/shops/${shop}/members/${mgr.userId}`)).status).toBe(200);
    expect((await call(a, mgr.token, 'GET', `/v1/shops/${shop}`)).status).toBe(404);
  });

  it('rejects malformed ids and body fields', async () => {
    const u = await signup('u@example.com');
    const shop = await mkShop(u.token, 'shop-one');
    expect((await call(a, u.token, 'GET', '/v1/shops/not-a-uuid')).status).toBe(400);
    expect((await call(a, u.token, 'PATCH', `/v1/shops/${shop}`, { id: 'x' })).status).toBe(400);
    expect((await call(a, u.token, 'PATCH', `/v1/shops/${shop}`, {})).status).toBe(400);
    expect((await call(a, u.token, 'POST', `/v1/shops/${shop}/members`, { email: 'a@b.co', role: 'admin' })).status).toBe(400);
  });
});
