import { afterEach, describe, expect, it } from 'vitest';
import { call, makeApp, type TestApp } from '../helpers';
import { ScriptedLlm } from '../fixtures/scripted-llm';

const PW = 'correct horse battery';
let a: TestApp | undefined;
afterEach(async () => {
  await a?.close();
  a?.cleanup();
  a = undefined;
});

async function login(email: string) {
  await call(a!, null, 'POST', '/v1/auth/register', { email, displayName: email, password: PW });
  return (await call(a!, null, 'POST', '/v1/auth/login', { email, password: PW })).body.token as string;
}

async function setup() {
  a = await makeApp({ llm: new ScriptedLlm([]), publicUrl: 'https://hepson.example' });
  const token = await login('o@example.com');
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Льон & Ко', slug: 'lon' })).body.shopId as string;
  const other = (await call(a, token, 'POST', '/v1/shops', { name: 'Інший', slug: 'other' })).body.shopId as string;
  const c = a.catalog;
  await c.createProduct(shopId, {
    name: 'Сукня',
    description: 'Льон, міді',
    priceMinor: 129_900,
    currency: 'UAH',
    media: ['https://img.example/dress.jpg'],
    variants: [
      { sku: 'DR-S', options: { size: 'S' }, stock: 2 },
      { sku: 'DR-M', options: { size: 'M' }, stock: 0 },
      { sku: 'DR-L', options: { size: 'L' }, priceMinor: 139_900, stock: 1 },
    ],
  });
  await c.createProduct(shopId, { name: 'Розпродано', priceMinor: 100, currency: 'UAH', sku: 'SOLD', stock: 0 });
  await c.createProduct(shopId, { name: 'Прихований', priceMinor: 100, currency: 'UAH', sku: 'OFF', stock: 5, active: false });
  await c.createProduct(shopId, { name: '<script>alert(1)</script>', priceMinor: 5_050, currency: 'UAH', sku: 'XSS', stock: 3, media: ['javascript:alert(1)'] });
  await c.createProduct(other, { name: 'Чужий товар', priceMinor: 100, currency: 'UAH', sku: 'OTHER', stock: 5 });
  return { token, shopId, other };
}

const page = (url: string) => a!.app.inject({ method: 'GET', url });

describe('storefront', () => {
  it('is off until the owner turns it on; only the owner can', async () => {
    const s = await setup();
    const off = await page('/s/lon');
    expect(off.statusCode).toBe(404);
    expect(off.body).not.toContain('Сукня');
    expect((await page('/s/nope')).statusCode).toBe(404);

    const mgr = await login('m@example.com');
    await call(a!, s.token, 'POST', `/v1/shops/${s.shopId}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a!, mgr, 'PATCH', `/v1/shops/${s.shopId}`, { storefrontEnabled: true })).status).toBe(403);
    const on = await call(a!, s.token, 'PATCH', `/v1/shops/${s.shopId}`, { storefrontEnabled: true });
    expect(on.body).toMatchObject({ storefrontEnabled: true });
    expect((await page('/s/lon')).statusCode).toBe(200);
  });

  it('shows active in-stock products and variants of this shop only, escaped, without stock counts; strict headers', async () => {
    const s = await setup();
    await call(a!, s.token, 'PATCH', `/v1/shops/${s.shopId}`, { storefrontEnabled: true });
    const r = await page('/s/lon');
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['content-security-policy']).toContain('script-src https://hepson.example');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain('font-src https://hepson.example');
    const font = await page('/s/_fonts/geist-cyrillic.woff2');
    expect(font.statusCode).toBe(200);
    expect(font.headers['content-type']).toBe('font/woff2');
    expect((await page('/s/_fonts/../../etc/passwd')).statusCode).toBe(404);
    expect((await page('/s/_fonts/other.woff2')).statusCode).toBe(404);
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    const html = r.body;
    expect(html).toContain('<title>Льон &amp; Ко: каталог</title>');
    expect(html).toContain('Сукня');
    expect(html).toMatch(/від 1\s299 ₴/); // uk-UA groups thousands with a no-break space
    expect(html).toMatch(/<p class="opts">(S · L|L · S)<\/p>/); // in-stock sizes only, in catalog order
    expect(html).not.toMatch(/>M</);
    expect(html).toContain('src="https://img.example/dress.jpg"');
    for (const hidden of ['Розпродано', 'Прихований', 'Чужий товар', 'DR-S', '<script>alert', 'javascript:']) expect(html, hidden).not.toContain(hidden);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('51 ₴'); // whole units, as in the dashboard
    // No chat connected: no widget and no chat links.
    expect(html).not.toContain('web-chat.js');
    expect(html).not.toContain('t.me/');
  });

  it('pages after 48 products', async () => {
    const s = await setup();
    await call(a!, s.token, 'PATCH', `/v1/shops/${s.shopId}`, { storefrontEnabled: true });
    for (let i = 0; i < 50; i++) await a!.catalog.createProduct(s.shopId, { name: `Товар ${i}`, priceMinor: 100, currency: 'UAH', sku: `T-${i}`, stock: 1 });
    const p1 = (await page('/s/lon')).body;
    const p2 = (await page('/s/lon?page=2')).body;
    expect((p1.match(/<li class="card">/g) ?? []).length).toBe(48);
    expect((p2.match(/<li class="card">/g) ?? []).length).toBe(4);
    expect(p1).toContain('href="?page=2"');
    expect((await page('/s/lon?page=99')).statusCode).toBe(200);
  });

  it('offers the shop chats; the website chat widget runs on the storefront origin only while the storefront is on', async () => {
    const s = await setup();
    await call(a!, s.token, 'PATCH', `/v1/shops/${s.shopId}`, { storefrontEnabled: true });
    await a!.tgRepo.upsertChannel(s.shopId, { botId: '1', botUsername: 'lon_shop_bot', webhookId: 'w'.repeat(32), secret: 's'.repeat(43) });
    const key = (await call(a!, s.token, 'PUT', `/v1/shops/${s.shopId}/web-chat`, { enabled: true })).body.widgetKey as string;
    const html = (await page('/s/lon')).body;
    expect(html).toContain('href="https://t.me/lon_shop_bot"');
    expect(html).toContain(`<script src="https://hepson.example/widget/web-chat.js" data-key="${key}" data-lang="uk" async></script>`);

    const session = (headers: Record<string, string>) =>
      a!.app.inject({ method: 'POST', url: `/public/web-chat/${key}/session`, headers: { 'content-type': 'application/json', ...headers }, payload: '{}' });
    const open = await session({ origin: 'https://hepson.example' });
    expect(open.statusCode).toBe(201);
    const token = open.json().token as string;
    // Same-origin GETs carry no Origin header; Sec-Fetch-Site tells the browser's view.
    const poll = (headers: Record<string, string>) => a!.app.inject({ method: 'GET', url: `/public/web-chat/${key}/messages`, headers: { 'x-hepson-visitor': token, ...headers } });
    expect((await poll({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect((await poll({})).statusCode).toBe(403);
    expect((await session({ origin: 'https://evil.example' })).statusCode).toBe(403);

    await call(a!, s.token, 'PATCH', `/v1/shops/${s.shopId}`, { storefrontEnabled: false });
    expect((await session({ origin: 'https://hepson.example' })).statusCode).toBe(403);
    expect((await poll({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(403);
  });
});
