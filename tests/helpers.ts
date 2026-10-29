import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type App } from '../apps/api/src/server';

export async function makeApp(over: Parameters<typeof buildApp>[0] & { dir?: string } = {}) {
  const dir = over.dir ?? mkdtempSync(path.join(os.tmpdir(), 'hepson-test-'));
  const a = await buildApp({ dataDir: dir, dbFile: path.join(dir, 'hepson.db'), logger: false, autostart: false, pollIntervalMs: 3_600_000, browserHeadless: true, ...over });
  const admin = a.store.createApiKey('admin', null).key;
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

export async function mockAccount(a: TestApp, label = 'mock-shop', start = true) {
  const r = await call(a, a.admin, 'POST', '/v1/accounts', { label, connectorType: 'mock', consentConfirmed: false });
  const id = r.body.accountId as string;
  if (start) await call(a, a.admin, 'POST', `/v1/accounts/${id}/session/start`, {});
  return id;
}
