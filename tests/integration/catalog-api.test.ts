import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthRepository } from '@hepson/database';
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
  const r = await call(a, null, 'POST', '/v1/auth/register', { email, displayName: 'U', password: PW });
  const l = await call(a, null, 'POST', '/v1/auth/login', { email, password: PW });
  return { token: l.body.token as string, userId: r.body.userId as string };
}
async function setup() {
  const owner = await signup('owner@example.com');
  const mgr = await signup('mgr@example.com');
  const out = await signup('out@example.com');
  const shop = (await call(a, owner.token, 'POST', '/v1/shops', { name: 'S', slug: 'shop-one' })).body.shopId as string;
  await call(a, owner.token, 'POST', `/v1/shops/${shop}/members`, { email: 'mgr@example.com', role: 'manager' });
  const other = (await call(a, out.token, 'POST', '/v1/shops', { name: 'O', slug: 'shop-two' })).body.shopId as string;
  return { owner, mgr, out, shop, other };
}
const body = { name: 'Футболка', priceMinor: 49900, sku: 'tee-1', stock: 3 };

describe('catalog API', () => {
  it('owner creates product; currency defaults to shop currency; effective price shown', async () => {
    const { owner, shop } = await setup();
    const r = await call(a, owner.token, 'POST', `/v1/shops/${shop}/products`, { ...body, variants: undefined, sku: 'tee-1' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Футболка', currency: 'UAH', priceMinor: 49900 });
    expect(r.body.variants[0]).toMatchObject({ sku: 'TEE-1', stock: 3, priceMinor: 49900, priceOverrideMinor: null });
    const withV = await call(a, owner.token, 'POST', `/v1/shops/${shop}/products`, { name: 'Куртка', priceMinor: 1000, variants: [{ sku: 'j-m', options: { size: 'M' }, priceMinor: 1500 }] });
    expect(withV.body.variants[0].priceMinor).toBe(1500);
  });

  it('validation and duplicate SKU return 400', async () => {
    const { owner, shop } = await setup();
    const url = `/v1/shops/${shop}/products`;
    await call(a, owner.token, 'POST', url, body);
    expect((await call(a, owner.token, 'POST', url, body)).status).toBe(400);
    expect((await call(a, owner.token, 'POST', url, { ...body, sku: 'n2', priceMinor: -1 })).status).toBe(400);
    expect((await call(a, owner.token, 'POST', url, { ...body, sku: 'n3', stock: -5 })).status).toBe(400);
    expect((await call(a, owner.token, 'POST', url, { ...body, sku: 'n4', shopId: 'x' })).status).toBe(400);
    expect((await call(a, owner.token, 'GET', url)).body.total).toBe(1);
  });

  it('manager can read and change stock but not edit catalog', async () => {
    const { owner, mgr, shop } = await setup();
    const p = (await call(a, owner.token, 'POST', `/v1/shops/${shop}/products`, body)).body;
    const pu = `/v1/shops/${shop}/products/${p.productId}`;
    const vu = `${pu}/variants/${p.variants[0].variantId}`;
    expect((await call(a, mgr.token, 'GET', pu)).status).toBe(200);
    expect((await call(a, mgr.token, 'GET', `/v1/shops/${shop}/products?q=ФУТБОЛКА`)).body.total).toBe(1);
    expect((await call(a, mgr.token, 'POST', `${vu}/stock`, { delta: -2 })).body.stock).toBe(1);
    expect((await call(a, mgr.token, 'POST', `${vu}/stock`, { delta: -2 })).status).toBe(400);
    expect((await call(a, mgr.token, 'POST', `${vu}/stock`, { set: 20 })).body.stock).toBe(20);
    expect((await call(a, mgr.token, 'POST', `${vu}/stock`, { set: -1 })).status).toBe(400);
    expect((await call(a, mgr.token, 'POST', `${vu}/stock`, { delta: 1, set: 2 })).status).toBe(400);
    expect((await call(a, mgr.token, 'POST', `/v1/shops/${shop}/products`, { ...body, sku: 'm1' })).status).toBe(403);
    expect((await call(a, mgr.token, 'PATCH', pu, { name: 'x' })).status).toBe(403);
    expect((await call(a, mgr.token, 'POST', `${pu}/variants`, { sku: 'm2' })).status).toBe(403);
    expect((await call(a, mgr.token, 'PATCH', vu, { active: false })).status).toBe(403);
  });

  it('owner edits product and variants', async () => {
    const { owner, shop } = await setup();
    const p = (await call(a, owner.token, 'POST', `/v1/shops/${shop}/products`, body)).body;
    const pu = `/v1/shops/${shop}/products/${p.productId}`;
    expect((await call(a, owner.token, 'PATCH', pu, { active: false, description: 'd' })).body).toMatchObject({ active: false, description: 'd' });
    const v = await call(a, owner.token, 'POST', `${pu}/variants`, { sku: 'tee-2', options: { size: 'XL' }, stock: 1 });
    expect(v.status).toBe(201);
    expect((await call(a, owner.token, 'PATCH', `${pu}/variants/${v.body.variantId}`, { priceMinor: 999 })).body.priceMinor).toBe(999);
    expect((await call(a, owner.token, 'PATCH', `${pu}/variants/${v.body.variantId}`, { stock: 5 })).status).toBe(400);
    expect((await call(a, owner.token, 'GET', pu)).body.variants).toHaveLength(2);
  });

  it('cross-shop: non-member gets 404 everywhere; shop B ids never resolve under shop A', async () => {
    const { owner, out, shop, other } = await setup();
    const p = (await call(a, owner.token, 'POST', `/v1/shops/${shop}/products`, body)).body;
    const vid = p.variants[0].variantId;
    const u = `/v1/shops/${shop}/products`;
    const attempts: Array<[Parameters<typeof call>[2], string, unknown?]> = [
      ['GET', u],
      ['POST', u, { ...body, sku: 'evil' }],
      ['GET', `${u}/${p.productId}`],
      ['PATCH', `${u}/${p.productId}`, { name: 'evil' }],
      ['POST', `${u}/${p.productId}/variants`, { sku: 'evil2' }],
      ['PATCH', `${u}/${p.productId}/variants/${vid}`, { active: false }],
      ['POST', `${u}/${p.productId}/variants/${vid}/stock`, { set: 0 }],
    ];
    for (const [m, url, b] of attempts) expect((await call(a, out.token, m, url, b)).status, `${m} ${url}`).toBe(404);
    // Out's own shop B: product id from shop A is not found under B's path.
    const ub = `/v1/shops/${other}/products`;
    expect((await call(a, out.token, 'GET', `${ub}/${p.productId}`)).status).toBe(404);
    expect((await call(a, out.token, 'POST', `${ub}/${p.productId}/variants/${vid}/stock`, { set: 0 })).status).toBe(404);
    expect((await call(a, out.token, 'PATCH', `${ub}/${p.productId}`, { name: 'evil' })).status).toBe(404);
    expect((await call(a, out.token, 'GET', ub)).body.total).toBe(0);
    const after = (await call(a, owner.token, 'GET', `${u}/${p.productId}`)).body;
    expect(after).toMatchObject({ name: 'Футболка' });
    expect(after.variants[0]).toMatchObject({ stock: 3, active: true });
  });

  it('requires a user session', async () => {
    const { shop } = await setup();
    expect((await call(a, null, 'GET', `/v1/shops/${shop}/products`)).status).toBe(401);
    expect((await call(a, a.admin, 'GET', `/v1/shops/${shop}/products`)).status).toBe(401);
  });

  it('search params and pagination', async () => {
    const { owner, shop } = await setup();
    const u = `/v1/shops/${shop}/products`;
    for (const n of [1, 2, 3]) await call(a, owner.token, 'POST', u, { name: `Товар ${n}`, priceMinor: 1, sku: `p${n}` });
    expect((await call(a, owner.token, 'GET', `${u}?limit=2`)).body).toMatchObject({ total: 3 });
    expect((await call(a, owner.token, 'GET', `${u}?limit=2`)).body.items).toHaveLength(2);
    expect((await call(a, owner.token, 'GET', `${u}?q=p2`)).body.total).toBe(1);
    expect((await call(a, owner.token, 'GET', `${u}?active=maybe`)).status).toBe(400);
    expect((await call(a, owner.token, 'GET', `${u}?limit=9999`)).status).toBe(400);
  });
});

describe('catalog CSV import API', () => {
  const csv = 'sku,name,price,stock\nimp-1,Імпорт,100.50,3\nimp-2,Другий,20,0\n';
  const url = (shop: string) => `/v1/shops/${shop}/products/import`;

  it('owner: dry run is the default and writes nothing; dryRun=false applies', async () => {
    const { owner, shop } = await setup();
    const dry = await call(a, owner.token, 'POST', url(shop), { csv });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, applied: false, created: { products: 2, variants: 2 }, errors: [] });
    expect((await call(a, owner.token, 'GET', `/v1/shops/${shop}/products`)).body.total).toBe(0);
    const real = await call(a, owner.token, 'POST', url(shop), { csv, dryRun: false });
    expect(real.body).toMatchObject({ dryRun: false, applied: true });
    const list = await call(a, owner.token, 'GET', `/v1/shops/${shop}/products`);
    expect(list.body.total).toBe(2);
    expect(list.body.items.find((p: { name: string }) => p.name === 'Імпорт')).toMatchObject({ priceMinor: 10050, currency: 'UAH' });
  });

  it('row errors come back as 200 with applied=false', async () => {
    const { owner, shop } = await setup();
    const r = await call(a, owner.token, 'POST', url(shop), { csv: 'sku,name,price\nok,Ok,1\nbad,,1\n', dryRun: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: false, errors: [{ line: 3 }] });
    expect((await call(a, owner.token, 'GET', `/v1/shops/${shop}/products`)).body.total).toBe(0);
  });

  it('bad header is a 400; manager 403; outsider 404; no session 401; cross-shop write impossible', async () => {
    const { owner, mgr, out, shop, other } = await setup();
    expect((await call(a, owner.token, 'POST', url(shop), { csv: 'name\nx\n' })).status).toBe(400);
    expect((await call(a, mgr.token, 'POST', url(shop), { csv })).status).toBe(403);
    expect((await call(a, out.token, 'POST', url(shop), { csv })).status).toBe(404);
    expect((await call(a, null, 'POST', url(shop), { csv })).status).toBe(401);
    expect((await call(a, a.admin, 'POST', url(shop), { csv })).status).toBe(401);
    await call(a, owner.token, 'POST', url(shop), { csv, dryRun: false });
    expect((await call(a, out.token, 'GET', `/v1/shops/${other}/products`)).body.total).toBe(0);
  });

  it('accepts a body above the global 64 KB limit', async () => {
    const { owner, shop } = await setup();
    const big = 'sku,name,price\n' + Array.from({ length: 4000 }, (_, i) => `s${i},Товар ${i},1`).join('\n');
    expect(big.length).toBeGreaterThan(64 * 1024);
    const r = await call(a, owner.token, 'POST', url(shop), { csv: big, dryRun: false });
    expect(r.body).toMatchObject({ applied: true, created: { products: 4000 } });
  });
});

describe('hardening', () => {
  it('/ready answers and API responses are not cacheable', async () => {
    const r = await call(a, null, 'GET', '/ready');
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    const h = await call(a, null, 'GET', '/v1/openapi.json');
    expect(h.headers['cache-control']).toBe('no-store');
    expect(h.headers['x-content-type-options']).toBe('nosniff');
    expect(h.headers['referrer-policy']).toBe('no-referrer');
  });
  it('widget script keeps its own cache policy', async () => {
    const r = await call(a, null, 'GET', '/widget/web-chat.js');
    expect(r.headers['cache-control']).toBe('public, max-age=300');
  });
  it('purges sessions expired or revoked over a week ago, keeps the rest', async () => {
    const u = await signup('p@example.com');
    const { userId } = u;
    const day = 86_400_000;
    let now = Date.now();
    const repo = new AuthRepository(a.handle, () => new Date(now));
    const expired = repo.createSession(userId, day);
    const revoked = repo.createSession(userId, 30 * day);
    repo.revokeSession(revoked.id);
    const live = repo.createSession(userId, 30 * day);
    expect(repo.purgeDeadSessions()).toBe(0);
    now += 6 * day;
    expect(repo.purgeDeadSessions()).toBe(0);
    now += 3 * day;
    expect(repo.purgeDeadSessions()).toBe(2);
    expect(repo.findSession(live.token)).toBeDefined();
    expect(repo.findSession(expired.token)).toBeUndefined();
    expect((await call(a, u.token, 'GET', '/v1/auth/me')).status).toBe(200);
  });
});
