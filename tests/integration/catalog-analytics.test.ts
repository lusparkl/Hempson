import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEB_CHANNEL } from '@hepson/database';
import { call, makeApp, type TestApp } from '../helpers';
import { ScriptedLlm } from '../fixtures/scripted-llm';
import { NP } from '../fixtures/fake-nova-poshta';

// Google's answers are modelled on public-sheet behaviour (export redirects to a googleusercontent host), not captured live.
const PW = 'correct horse battery';
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';
const SHEET = `https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing#gid=0`;
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

function fakeGoogle() {
  const g = {
    calls: [] as string[],
    answer: (url: string): Response =>
      url.startsWith('https://docs.google.com/')
        ? new Response(null, { status: 307, headers: { location: 'https://doc-0c-1a-sheets.googleusercontent.com/export/x?format=csv' } })
        : new Response('sku,name,price,stock\nTEE-S,Футболка,499,7\nTEE-M,Футболка M,499,3\n', { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } }),
  };
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    g.calls.push(String(input));
    return g.answer(String(input));
  }) as unknown as typeof fetch;
  return Object.assign(g, { fetchImpl });
}

async function setup() {
  const google = fakeGoogle();
  a = await makeApp({ llm: new ScriptedLlm([]), fetchImpl: google.fetchImpl, paymentCheckMinutes: 0, novaPoshtaPollMinutes: 0 });
  const token = await login('o@example.com');
  const shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Магазин', slug: 'shop-one' })).body.shopId as string;
  return { google, token, shopId, base: `/v1/shops/${shopId}` };
}
type S = Awaited<ReturnType<typeof setup>>;

describe('Google Sheets import', () => {
  it('previews by default, applies on request, through the CSV importer; owner only', async () => {
    const s = await setup();
    const dry = await call(a!, s.token, 'POST', `${s.base}/products/import-sheet`, { url: SHEET });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, applied: false, rows: 2, created: { variants: 2 }, errors: [] });
    expect(a!.catalog.findVariantBySku(s.shopId, 'TEE-S')).toBeUndefined();
    expect(s.google.calls).toEqual([`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=0`, 'https://doc-0c-1a-sheets.googleusercontent.com/export/x?format=csv']);

    const run = await call(a!, s.token, 'POST', `${s.base}/products/import-sheet`, { url: SHEET, dryRun: false });
    expect(run.body).toMatchObject({ applied: true });
    expect(a!.catalog.findVariantBySku(s.shopId, 'TEE-M')).toMatchObject({ stock: 3 });

    const mgr = await login('m@example.com');
    await call(a!, s.token, 'POST', `${s.base}/members`, { email: 'm@example.com', role: 'manager' });
    expect((await call(a!, mgr, 'POST', `${s.base}/products/import-sheet`, { url: SHEET })).status).toBe(403);
  });

  it('a link that is not a Google Sheet is refused before any request; Google errors become owner-readable', async () => {
    const s = await setup();
    for (const url of ['https://evil.example/sheet.csv', 'http://169.254.169.254/latest/meta-data', `https://docs.google.com.evil.example/spreadsheets/d/${ID}`]) {
      const r = await call(a!, s.token, 'POST', `${s.base}/products/import-sheet`, { url });
      expect(r.status, url).toBe(400);
    }
    expect(s.google.calls).toHaveLength(0);

    s.google.answer = () => new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin?continue=x' } });
    expect((await call(a!, s.token, 'POST', `${s.base}/products/import-sheet`, { url: SHEET })).body.error.message).toMatch(/Anyone with the link/);
    s.google.answer = () => new Response(null, { status: 307, headers: { location: 'https://evil.example/steal' } });
    expect((await call(a!, s.token, 'POST', `${s.base}/products/import-sheet`, { url: SHEET })).body.error.message).toMatch(/unexpected address/);
    expect(s.google.calls.some((c) => c.includes('evil.example'))).toBe(false);
  });
});

/** A website conversation with a COD draft created by `who`; returns the draft id. */
function draft(s: S, who: 'ai' | 'user', session: string) {
  const conv = a!.conversations.ensureConversation(s.shopId, { channel: WEB_CHANNEL, conversationExternalId: session, customer: { externalId: session, displayName: 'Олена' } })
    .conversation.id;
  return a!.orders.createDraft(s.shopId, {
    conversationId: conv,
    createdBy: who,
    items: [{ sku: 'HOODIE-M', quantity: 1 }],
    checkout: {
      firstName: 'Олена',
      lastName: 'Коваль',
      phone: '050 111 22 33',
      npCityRef: NP.kyivRef,
      npCityName: 'Київ',
      npWarehouseRef: NP.branch5Ref,
      npWarehouseName: 'Відділення №5',
      paymentMethod: 'cod',
    },
  }).draft.id;
}
const withCatalog = (s: S) =>
  a!.catalog.createProduct(s.shopId, { name: 'Худі Classic', priceMinor: 129_900, currency: 'UAH', variants: [{ sku: 'HOODIE-M', options: { size: 'M' }, stock: 50 }] });

describe('Excel export of orders', () => {
  it('a workbook with one row per order of the period; members only; period checked', async () => {
    const s = await setup();
    withCatalog(s);
    const id = draft(s, 'ai', 'w1');
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${id}/approve`, {});
    draft(s, 'user', 'w2');
    const res = await a!.app.inject({ method: 'GET', url: `${s.base}/order-drafts/export.xlsx`, headers: { authorization: `Bearer ${s.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="orders-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const body = res.rawPayload;
    expect(body.subarray(0, 2).toString()).toBe('PK');
    const xml = body.toString('utf8'); // stored entries: the sheet XML is in the file as is
    expect(xml).toContain('>Замовлення<');
    expect(xml).toContain(`>${id}<`);
    expect(xml).toContain('>HOODIE-M Худі Classic (M) × 1<');
    expect(xml).toContain('<v>1299</v>');
    expect(xml.match(/<row /g)).toHaveLength(3);

    const only = await a!.app.inject({ method: 'GET', url: `${s.base}/order-drafts/export.xlsx?status=cod_confirmed`, headers: { authorization: `Bearer ${s.token}` } });
    expect(only.rawPayload.toString('utf8').match(/<row /g)).toHaveLength(2);
    const bad = (q: string) => call(a!, s.token, 'GET', `${s.base}/order-drafts/export.xlsx?${q}`);
    expect((await bad('from=2026-01-01T00:00:00Z&to=2027-06-01T00:00:00Z')).status).toBe(400);
    expect((await bad('from=2026-06-01T00:00:00Z&to=2026-05-01T00:00:00Z')).status).toBe(400);
    expect((await call(a!, await login('x@example.com'), 'GET', `${s.base}/order-drafts/export.xlsx`)).status).toBe(404);
  });
});

describe('funnel and AI vs human', () => {
  it('stage counts equal the order_events rows; sources split by creator and approver', async () => {
    const s = await setup();
    withCatalog(s);
    await call(a!, s.token, 'PUT', `${s.base}/ai`, { enabled: true });
    // Two customers write; the AI drafts three orders, a manager one.
    for (const w of ['w1', 'w2'])
      a!.conversations.ingestMessage(s.shopId, {
        channel: WEB_CHANNEL,
        conversationExternalId: w,
        customer: { externalId: w },
        externalId: `in-${w}`,
        text: 'Привіт',
        attachments: [],
      });
    const [d1, d2, d3, d4] = [draft(s, 'ai', 'w1'), draft(s, 'ai', 'w2'), draft(s, 'ai', 'w3'), draft(s, 'user', 'w4')];
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${d1}/approve`, {});
    expect(a!.orders.autoConfirm(s.shopId, d2, { maxTotalMinor: null })).toMatchObject({ approved: true });
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${d4}/approve`, {});
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${d3}/reject`, {});
    for (const d of [d1, d2]) {
      a!.orders.claimTtn(s.shopId, d);
      a!.orders.completeTtn(s.shopId, d, { ttn: `2045000000000${d === d1 ? 1 : 2}`, documentRef: 'r' });
    }
    a!.orders.applyTracking(s.shopId, d1, { code: '9', text: 'Отримано', outcome: 'delivered', refusal: false });
    // A prepaid order paid: the only way into `paid`.
    const d5 = draft(s, 'ai', 'w5');
    a!.handle.raw.prepare("update order_drafts set payment_method = 'prepaid' where id = ?").run(d5);
    await call(a!, s.token, 'POST', `${s.base}/order-drafts/${d5}/approve`, {});
    a!.orders.markPaid(s.shopId, d5, 'provider:monobank', 'test');
    await a!.payments.whenIdle();
    await a!.notices.whenIdle();

    const st = (await call(a!, s.token, 'GET', `${s.base}/stats`)).body;
    const events = (to: string) =>
      (a!.handle.raw.prepare('select count(distinct draft_id) n from order_events where shop_id = ? and to_status = ?').get(s.shopId, to) as { n: number }).n;
    expect(st.funnel).toEqual({
      conversations: 2,
      drafts: events('pending_approval'),
      approved: events('approved'),
      paid: events('paid'),
      shipped: events('shipped'),
      delivered: events('delivered'),
    });
    expect(st.funnel).toMatchObject({ drafts: 5, approved: 4, paid: 1, shipped: 2, delivered: 1 });
    expect(st.orderSources).toEqual({ drafts: { ai: 4, human: 1 }, approved: { ai: 3, human: 1 }, approvedBy: { human: 3, auto: 1 } });

    // Another shop sees none of it.
    const t2 = await login('o2@example.com');
    const shop2 = (await call(a!, t2, 'POST', '/v1/shops', { name: 'Інший', slug: 'shop-two' })).body.shopId as string;
    expect((await call(a!, t2, 'GET', `/v1/shops/${shop2}/stats`)).body.funnel).toEqual({ conversations: 0, drafts: 0, approved: 0, paid: 0, shipped: 0, delivered: 0 });
  });
});
