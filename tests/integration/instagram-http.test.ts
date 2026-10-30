import { createHmac, randomBytes } from 'node:crypto';
import { INSTAGRAM_CHANNEL, Keyring } from '@hepson/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeApp, type TestApp } from '../helpers';

const APP_SECRET = 'app-secret-for-http-tests';
const VERIFY_TOKEN = 'verify-me';
let a: TestApp | undefined;

afterEach(async () => {
  await a?.close();
  a?.cleanup();
  a = undefined;
});

describe('Instagram webhook HTTP boundary', () => {
  it('rejects multibyte tokens with matching character lengths without throwing', async () => {
    a = await makeApp({ metaAppSecret: APP_SECRET, metaVerifyToken: VERIFY_TOKEN });
    const token = 'é'.repeat(VERIFY_TOKEN.length);
    const res = await a.app.inject({ method: 'GET', url: `/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=123` });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('compares valid multibyte verify tokens as bytes and returns the exact challenge', async () => {
    const token = 'мій-секрет';
    a = await makeApp({ metaAppSecret: APP_SECRET, metaVerifyToken: token });
    const res = await a.app.inject({ method: 'GET', url: `/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=00123` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('00123');
    expect(res.headers['content-type']).toBe('text/plain');
  });

  it('verifies the exact UTF-8 bytes before parsing a JSON payload with whitespace', async () => {
    a = await makeApp({ metaAppSecret: APP_SECRET, metaVerifyToken: VERIFY_TOKEN });
    const handleWebhook = vi.spyOn(a.ig, 'handleWebhook');
    const raw = '{ "object": "instagram", "entry": [], "text": "Привіт 🌻" }\n';
    const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
    const headers = { 'content-type': 'application/json; charset=utf-8', 'x-hub-signature-256': signature };

    expect((await a.app.inject({ method: 'POST', url: '/webhooks/instagram', headers, payload: raw })).statusCode).toBe(200);
    expect(handleWebhook).toHaveBeenCalledExactlyOnceWith(JSON.parse(raw));
    expect((await a.app.inject({ method: 'POST', url: '/webhooks/instagram', headers, payload: raw.trim() })).statusCode).toBe(401);
    expect(handleWebhook).toHaveBeenCalledTimes(1);
  });

  it('asks Meta to retry an event delivered while the first subscription is still being confirmed', async () => {
    const igId = '17841400000000001';
    const customerId = '5551230001';
    const raw = JSON.stringify({
      object: 'instagram',
      entry: [
        { id: igId, messaging: [{ sender: { id: customerId }, recipient: { id: igId }, timestamp: Date.now(), message: { mid: 'subscription-race-mid', text: 'First message' } }] },
      ],
    });
    const request = {
      method: 'POST' as const,
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}` },
      payload: raw,
    };
    let earlyResponse: { statusCode: number; body: string } | undefined;
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    a = await makeApp({
      keyring: new Keyring(1, randomBytes(32)),
      metaAppId: 'app',
      metaConfigId: 'config',
      metaAppSecret: APP_SECRET,
      metaVerifyToken: VERIFY_TOKEN,
      fetchImpl: (async (input) => {
        const url = String(input);
        if (url.includes('/oauth/access_token')) return json({ access_token: 'synthetic-token' });
        if (url.includes('/assigned_instagram_accounts')) return json({ data: [{ id: igId }] });
        if (url.includes('/subscribed_apps')) {
          earlyResponse = await a!.app.inject(request);
          return json({ success: true });
        }
        return json({});
      }) as typeof fetch,
    });
    const shop = a.shops.create({ name: 'Race test', slug: 'race-test' });
    const user = a.auth.createUser({ email: 'race@example.test', displayName: 'Race test' }, 'unused');
    const state = new URL(a.ig.startConnect(shop.id, user.id).authorizeUrl).searchParams.get('state')!;

    await a.ig.completeConnect('code', state);

    expect(earlyResponse?.statusCode).toBe(503);
    expect(JSON.parse(earlyResponse!.body).error).toMatchObject({ code: 'TEMPORARY_FAILURE', retryable: true });
    expect(a.ig.status(shop.id).status).toBe('connected');
    expect(a.conversations.findConversationByExternal(shop.id, INSTAGRAM_CHANNEL, customerId)).toBeUndefined();
    expect((await a.app.inject(request)).statusCode).toBe(200);
    const conversation = a.conversations.findConversationByExternal(shop.id, INSTAGRAM_CHANNEL, customerId)!.conversation;
    expect(a.conversations.listMessages(shop.id, conversation.id, { limit: 10 }).items).toHaveLength(1);
    await a.ig.whenIdle();
  });

  it('redacts encoded and duplicate OAuth and webhook query secrets from request logs', async () => {
    const lines: string[] = [];
    const logStream = { write: (line: string) => void lines.push(line) } as unknown as NodeJS.WritableStream;
    a = await makeApp({ metaAppSecret: APP_SECRET, metaVerifyToken: VERIFY_TOKEN, logger: true, logLevel: 'trace', logStream });

    await a.app.inject({ method: 'GET', url: '/webhooks/instagram?hub.mode=subscribe&hub%2everify_token=encoded-verify-secret&hub.challenge=123' });
    await a.app.inject({ method: 'GET', url: '/public/instagram/callback?co%64e=encoded-code-secret&st%61te=encoded-state-secret&state=plain-state-secret' });

    const logs = lines.join('');
    for (const secret of ['encoded-verify-secret', 'encoded-code-secret', 'encoded-state-secret', 'plain-state-secret']) expect(logs).not.toContain(secret);
    const requests = lines.map((line) => JSON.parse(line) as { req?: { url?: string } }).flatMap((line) => (line.req?.url ? [line.req.url] : []));
    expect(requests).toEqual([
      '/webhooks/instagram?hub.mode=subscribe&hub%2everify_token=[redacted]&hub.challenge=123',
      '/public/instagram/callback?co%64e=[redacted]&st%61te=[redacted]&state=[redacted]',
    ]);
  });
});
