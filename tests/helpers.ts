import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WEB_CHANNEL } from '@hepson/database';
import { buildApp, type App } from '../apps/api/src/server';

export async function makeApp(over: Parameters<typeof buildApp>[0] & { dir?: string } = {}) {
  const dir = over.dir ?? mkdtempSync(path.join(os.tmpdir(), 'hepson-test-'));
  const a = await buildApp({ dataDir: dir, dbFile: path.join(dir, 'hepson.db'), logger: false, ...over });
  const admin = (await a.apiKeys.create('admin')).key;
  return { ...a, dir, admin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
export type TestApp = Awaited<ReturnType<typeof makeApp>>;

export const authH = (key: string) => ({ authorization: `Bearer ${key}` });

export async function call(a: { app: App['app'] }, key: string | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await a.app.inject({ method, url, headers: key ? authH(key) : {}, payload: payload as never });
  return { status: res.statusCode, body: res.body ? safeJson(res.body) : null, headers: res.headers };
}
const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/**
 * A customer message arriving on a channel, as a channel service records it: stored in the shop tables, then handed to
 * the agent. Default channel is the website chat (replies are delivered internally); returns the shop conversation id.
 */
export async function customerWrites(a: TestApp, shopId: string, thread: string, text: string, channel = WEB_CHANNEL) {
  const r = await a.conversations.ingestMessage(shopId, {
    channel,
    conversationExternalId: thread,
    customer: { externalId: thread, displayName: 'Олена' },
    externalId: `in:${randomUUID()}`,
    text,
  });
  await a.salesAgent?.trigger(shopId, r.conversation.id, r.message.id);
  await a.salesAgent?.whenIdle();
  return r.conversation.id;
}
