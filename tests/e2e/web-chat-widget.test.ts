import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, call, type TestApp } from '../helpers';

// Real Chromium, the real widget script, a "shop site" on one origin and the API on another (cross-origin, CORS).
let a: TestApp;
let browser: Browser;
let site: http.Server;
let apiBase = '';
let siteOrigin = '';
let key = '';
let token = '';
let shopId = '';

const html = () => `<!doctype html><html><body><h1>Shop</h1><script src="${apiBase}/widget/web-chat.js" data-key="${key}" async></script></body></html>`;

beforeAll(async () => {
  a = await makeApp();
  await a.app.listen({ port: 0, host: '127.0.0.1' });
  apiBase = `http://127.0.0.1:${(a.app.server.address() as AddressInfo).port}`;
  site = http.createServer((_, res) => res.setHeader('content-type', 'text/html').end(html()));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  siteOrigin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  await call(a, null, 'POST', '/v1/auth/register', { email: 'o@example.com', displayName: 'O', password: 'correct horse battery' });
  token = (await call(a, null, 'POST', '/v1/auth/login', { email: 'o@example.com', password: 'correct horse battery' })).body.token;
  shopId = (await call(a, token, 'POST', '/v1/shops', { name: 'Shop', slug: 'shop-one' })).body.shopId;
  key = (await call(a, token, 'PUT', `/v1/shops/${shopId}/web-chat`, { enabled: true, allowedOrigins: [siteOrigin] })).body.widgetKey;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  site?.close();
  await a?.close();
  a?.cleanup();
});

const root = '(document.body.lastElementChild.shadowRoot)';

describe('website chat widget in a real browser', () => {
  it('opens, sends, shows a human reply, escapes HTML, and keeps the session across reloads', async () => {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(siteOrigin);
    await page.waitForFunction(`!!document.body.lastElementChild && !!document.body.lastElementChild.shadowRoot`);
    await page.evaluate(`${root}.lastElementChild.click()`);
    await page.evaluate(`(() => { const r = ${root}; r.querySelector('input').value = 'Привіт <b>M</b>?'; r.querySelector('form').requestSubmit(); })()`);
    await page.waitForFunction(`${root}.textContent.includes('Привіт')`);

    const conv = (await call(a, token, 'GET', `/v1/shops/${shopId}/conversations`)).body.items[0];
    expect(conv.channel).toBe('website');
    expect((await call(a, token, 'POST', `/v1/shops/${shopId}/conversations/${conv.conversationId}/messages`, { text: 'Так, є.' })).status).toBe(201);
    await page.waitForFunction(`${root}.textContent.includes('Так, є.')`, null, { timeout: 10_000 });
    expect(await page.evaluate(`!${root}.querySelector('b')`)).toBe(true);

    await page.reload();
    await page.waitForFunction(`!!document.body.lastElementChild && !!document.body.lastElementChild.shadowRoot`);
    await page.evaluate(`${root}.lastElementChild.click()`);
    await page.waitForFunction(`${root}.textContent.includes('Так, є.')`, null, { timeout: 10_000 });
    expect((await call(a, token, 'GET', `/v1/shops/${shopId}/conversations`)).body.total).toBe(1);
    expect(errors).toEqual([]);
  });

  it('a page on a non-allowed origin cannot use the chat API (browser CORS block, server refusal)', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('about:blank');
    const r = await page.evaluate(async ([base, k]) => {
      try {
        return `status ${(await fetch(`${base}/public/web-chat/${k}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status}`;
      } catch {
        return 'blocked';
      }
    }, [apiBase, key] as const);
    expect(r).toBe('blocked');
    const direct = await a.app.inject({ method: 'POST', url: `/public/web-chat/${key}/session`, headers: { origin: 'https://evil.example' }, payload: {} });
    expect(direct.statusCode).toBe(403);
  });
});
