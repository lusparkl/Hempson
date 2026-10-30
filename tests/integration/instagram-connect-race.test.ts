import { randomBytes } from 'node:crypto';
import { Keyring } from '@hepson/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from '../helpers';

const IG = '17841400000000001';
const OTHER_IG = '17841400000000002';
const TOKEN = 'synthetic-token';
const OTHER_TOKEN = 'other-synthetic-token';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

let a: TestApp;
let shopId: string;
let userId: string;
let calls: Array<{ method: string; path: string; token: string | null }>;
let exchange: (code: string) => Response | Promise<Response>;
let subscribe: (igId: string) => Response | Promise<Response>;
let unsubscribe: (igId: string) => Response | Promise<Response>;

beforeEach(async () => {
  calls = [];
  exchange = (code) => json({ access_token: code === 'other' ? OTHER_TOKEN : TOKEN });
  subscribe = () => json({ success: true });
  unsubscribe = () => json({ success: true });
  a = await makeApp({
    publicUrl: 'https://hepson.example',
    metaAppId: 'test-app',
    metaConfigId: 'test-config',
    metaAppSecret: 'test-app-secret',
    metaVerifyToken: 'test-verify',
    keyring: new Keyring(1, randomBytes(32)),
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const token = new Headers(init?.headers).get('authorization');
      calls.push({ method, path: url.pathname, token });
      if (url.pathname.endsWith('/oauth/access_token')) return exchange(url.searchParams.get('code')!);
      if (url.pathname.endsWith('/assigned_instagram_accounts')) return json({ data: [{ id: token === `Bearer ${OTHER_TOKEN}` ? OTHER_IG : IG }] });
      if (url.pathname.endsWith('/subscribed_apps')) {
        const igId = url.pathname.split('/').at(-2)!;
        return method === 'POST' ? subscribe(igId) : unsubscribe(igId);
      }
      throw new Error('Unexpected Graph request');
    }) as typeof fetch,
  });
  shopId = a.shops.create({ name: 'Connection race', slug: 'connection-race' }).id;
  userId = a.auth.createUser({ email: 'race@example.test', displayName: 'Race test' }, 'unused').id;
});

afterEach(async () => {
  await a?.close();
  a?.cleanup();
});

const connect = (code = 'first') => {
  const state = new URL(a.ig.startConnect(shopId, userId).authorizeUrl).searchParams.get('state')!;
  return a.ig.completeConnect(code, state);
};
const subscriptionCalls = (method: string) => calls.filter((c) => c.method === method && c.path.endsWith('/subscribed_apps'));

describe('Instagram connection cancellation', () => {
  it('does not reconnect after disconnect while the first subscription is pending', async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    subscribe = () => {
      started.resolve();
      return response.promise;
    };
    const pending = connect().catch((error: unknown) => error);
    await started.promise;

    await a.ig.disconnect(shopId);
    response.resolve(json({ success: true }));

    expect(await pending).toMatchObject({ code: 'TEMPORARY_FAILURE' });
    expect(a.igRepo.getChannel(shopId)).toBeUndefined();
    expect(a.vault.get(shopId, 'instagram')).toBeUndefined();
    expect(subscriptionCalls('DELETE')).toEqual([{ method: 'DELETE', path: `/v26.0/${IG}/subscribed_apps`, token: `Bearer ${TOKEN}` }]);
  });

  it('does not subscribe when disconnect cancels an unfinished code exchange', async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    exchange = () => {
      started.resolve();
      return response.promise;
    };
    const pending = connect().catch((error: unknown) => error);
    await started.promise;

    await a.ig.disconnect(shopId);
    response.resolve(json({ access_token: TOKEN }));

    expect(await pending).toMatchObject({ code: 'TEMPORARY_FAILURE' });
    expect(subscriptionCalls('POST')).toEqual([]);
    expect(subscriptionCalls('DELETE')).toEqual([]);
    expect(a.igRepo.getChannel(shopId)).toBeUndefined();
    expect(a.vault.get(shopId, 'instagram')).toBeUndefined();
  });

  it('rejects overlapping connection attempts for the same shop', async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    subscribe = () => {
      started.resolve();
      return response.promise;
    };
    const pending = connect();
    await started.promise;

    await expect(connect('other')).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE' });
    expect(calls.filter((c) => c.path.endsWith('/oauth/access_token'))).toHaveLength(1);
    response.resolve(json({ success: true }));

    await expect(pending).resolves.toEqual({ shopId });
    expect(a.igRepo.getChannel(shopId)!.igUserId).toBe(IG);
  });

  it.each(['pending', 'connected'])('preserves the newer %s connection while the canceled subscription finishes cleanup', async (newerStatus) => {
    const firstStarted = deferred<void>();
    const firstResponse = deferred<Response>();
    const secondStarted = deferred<void>();
    const secondResponse = deferred<Response>();
    subscribe = (igId) => {
      if (igId === IG) {
        firstStarted.resolve();
        return firstResponse.promise;
      }
      secondStarted.resolve();
      return secondResponse.promise;
    };
    const first = connect().catch((error: unknown) => error);
    await firstStarted.promise;
    await a.ig.disconnect(shopId);
    const second = connect('other');
    await secondStarted.promise;
    if (newerStatus === 'connected') {
      secondResponse.resolve(json({ success: true }));
      await expect(second).resolves.toEqual({ shopId });
    }

    firstResponse.resolve(json({ success: true }));
    expect(await first).toMatchObject({ code: 'TEMPORARY_FAILURE' });
    if (newerStatus === 'pending') {
      await expect(connect()).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE' });
      secondResponse.resolve(json({ success: true }));
      await expect(second).resolves.toEqual({ shopId });
    }

    expect(a.igRepo.getChannel(shopId)!.igUserId).toBe(OTHER_IG);
    expect(await a.vault.withSecret(shopId, 'instagram', (token) => token === OTHER_TOKEN)).toBe(true);
    expect(subscriptionCalls('DELETE').map((c) => c.path)).toEqual([`/v26.0/${IG}/subscribed_apps`]);
  });

  it('reserves the canceled account through best-effort cleanup and releases it even when cleanup fails', async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    const cleanupStarted = deferred<void>();
    const cleanupResponse = deferred<Response>();
    subscribe = () => {
      started.resolve();
      return response.promise;
    };
    unsubscribe = () => {
      cleanupStarted.resolve();
      return cleanupResponse.promise;
    };
    const pending = connect().catch((error: unknown) => error);
    await started.promise;
    await a.ig.disconnect(shopId);
    response.resolve(json({ success: true }));
    await cleanupStarted.promise;

    await expect(connect()).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE' });
    expect(subscriptionCalls('POST')).toHaveLength(1);
    cleanupResponse.resolve(json({ error: { code: 2 } }, 503));
    expect(await pending).toMatchObject({ code: 'TEMPORARY_FAILURE' });
    subscribe = () => json({ success: true });

    await expect(connect()).resolves.toEqual({ shopId });
    expect(a.igRepo.getChannel(shopId)!.igUserId).toBe(IG);
  });

  it('holds the shop reservation until an existing connection has finished disconnecting', async () => {
    await connect();
    const started = deferred<void>();
    const response = deferred<Response>();
    unsubscribe = () => {
      started.resolve();
      return response.promise;
    };
    const pending = a.ig.disconnect(shopId);
    await started.promise;

    await expect(connect('other')).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE' });
    await expect(a.ig.disconnect(shopId)).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE' });
    response.resolve(json({ success: true }));
    await pending;

    await expect(connect('other')).resolves.toEqual({ shopId });
    expect(a.igRepo.getChannel(shopId)!.igUserId).toBe(OTHER_IG);
    expect(await a.vault.withSecret(shopId, 'instagram', (token) => token === OTHER_TOKEN)).toBe(true);
  });
});
