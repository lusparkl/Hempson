import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { BrowserInstagramAdapter, profileDir } from '@hepson/instagram-browser';
import { call, makeApp, type TestApp } from '../helpers';
import type { FakeInstagram } from '../fixtures/fake-instagram';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(fn: () => T | Promise<T>, ms = 20_000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

export function adapterFor(dir: string, fake: FakeInstagram, over: Partial<ConstructorParameters<typeof BrowserInstagramAdapter>[0]> = {}) {
  return new BrowserInstagramAdapter({
    dataDir: dir,
    baseUrl: fake.url,
    headless: true,
    loginWaitMs: 30_000,
    maxConcurrent: 4,
    reconnectDelayMs: 200,
    sendConfirmMs: 1500,
    reloadInboxEveryMs: 0,
    ...over,
  });
}

/** Boots the whole API against the fake Instagram. Reuse `dir` to simulate a process restart. */
export async function bootApi(fake: FakeInstagram, dir?: string, over: Record<string, unknown> = {}) {
  let adapter!: BrowserInstagramAdapter;
  const app = await makeApp({ dir, instagramBaseUrl: fake.url, ...over } as never);
  // replace the default browser adapter with a fast-timing one
  adapter = adapterFor(app.dir, fake);
  (app.svc as any).adapters['instagram-browser'] = adapter;
  (app.svc as any).wire(adapter);
  return { ...app, adapter };
}
export type Booted = Awaited<ReturnType<typeof bootApi>>;

export const sessionOf = (b: Booted, id: string) =>
  (b.adapter as any).sessions.get(id) as { page: import('playwright').Page; context: import('playwright').BrowserContext } | undefined;

/** The shop OWNER signs in, in the visible window. (Simulated by loading the fake's login URL.) */
export async function ownerLogsIn(b: Booted, id: string, fake: FakeInstagram, handle: string) {
  const s = await until(() => sessionOf(b, id), 10_000, 'session window');
  await s!.page.goto(`${fake.url}/__login?user=${handle}`);
}

export async function createReal(b: Booted, label: string, handle?: string) {
  const r = await call(b, b.admin, 'POST', '/v1/accounts', {
    label,
    connectorType: 'instagram-browser',
    consentConfirmed: true,
    ...(handle ? { expectedInstagramHandle: handle } : {}),
  });
  return r.body.accountId as string;
}
export const status = async (b: Booted, id: string) => (await call(b, b.admin, 'GET', `/v1/accounts/${id}/status`)).body;
export const eventTypes = async (b: Booted, id: string): Promise<string[]> =>
  (await call(b, b.admin, 'GET', `/v1/accounts/${id}/events?limit=500`)).body.items.map((e: any) => e.type as string);
export const profileFiles = (dir: string, id: string) => {
  const p = profileDir(dir, id);
  return existsSync(p) ? readdirSync(p).length : 0;
};
export const profilePath = (dir: string, id: string) => path.join(dir, 'profiles', id);
