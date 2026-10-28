/**
 * OPT-IN live smoke test against a REAL shop-owned Instagram account. Never run by CI/vitest.
 *   HEPSON_LIVE_SMOKE=I_HAVE_OWNER_AUTHORIZATION HEPSON_API_KEY=... HEPSON_ACCOUNT_ID=... pnpm smoke:live
 * A human verifies each step and each live send. Results are NOT recorded automatically.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

if (process.env.HEPSON_LIVE_SMOKE !== 'I_HAVE_OWNER_AUTHORIZATION') {
  console.error('Refusing: set HEPSON_LIVE_SMOKE=I_HAVE_OWNER_AUTHORIZATION (shop owner consent required).');
  process.exit(1);
}
const base = process.env.HEPSON_URL ?? 'http://127.0.0.1:8787';
const id = process.env.HEPSON_ACCOUNT_ID!;
const h = { authorization: `Bearer ${process.env.HEPSON_API_KEY}`, 'content-type': 'application/json' };
const rl = createInterface({ input: process.stdin, output: process.stdout });
const api = async (m: string, p: string, b?: unknown) =>
  (await fetch(`${base}/v1/accounts/${id}${p}`, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined })).json() as Promise<any>;
const ask = async (q: string) => (await rl.question(`${q} [y/N] `)).trim().toLowerCase() === 'y';
const results: Array<[string, string]> = [];
const step = async (name: string, fn: () => Promise<boolean>) => {
  const ok = await fn();
  results.push([name, ok ? 'PASS (human-confirmed)' : 'FAIL/NOT VERIFIED']);
  console.log(`${ok ? '✔' : '✘'} ${name}`);
};

const st = await api('GET', '/status');
console.log('status:', st.status, st.statusMessage);
await step('Account connected (status=connected)', async () => (await api('GET', '/status')).status === 'connected');
await step('Existing conversations listed and match the visible Instagram inbox', async () => {
  const c = await api('GET', '/conversations?limit=10');
  console.table(c.items.map((x: any) => ({ title: x.title, time: x.latestMessageAt })));
  return ask('Do these match the real inbox?');
});
await step('Inbound DM from a SECOND authorized test user observed exactly once', async () => {
  console.log('Send a DM to the shop from the test user now…');
  await rl.question('press Enter after ~30s ');
  const e = await api('GET', '/events?limit=200');
  const n = e.items.filter((x: any) => x.type === 'message.received').length;
  console.log('message.received events:', n);
  return ask('Exactly one event for that DM?');
});
await step('Single outbound reply appears in Instagram as outgoing', async () => {
  const c = await api('GET', '/conversations?limit=10');
  const conv = c.items[0];
  if (!conv) return false;
  if (!(await ask(`Send a test reply to "${conv.title}" (enables outbound)?`))) return false;
  await api('PATCH', '/settings', { outboundEnabled: true });
  const r = await api('POST', `/conversations/${conv.id}/messages`, { text: 'Hepson test ✔', idempotencyKey: randomUUID() });
  await new Promise((r2) => setTimeout(r2, 8000));
  console.log(await api('GET', `/outbox/${r.outboxId}`));
  await api('PATCH', '/settings', { outboundEnabled: false });
  return ask('Did it appear ONCE in the real chat as outgoing?');
});
console.log('\nNow do the restart steps from docs/MANUAL_INSTAGRAM_TEST.md (stop everything, start again, confirm no login prompt).');
console.table(results.map(([a, b]) => ({ step: a, result: b })));
rl.close();
