/**
 * Example consumer of the public Hepson API: subscribe to new inbound messages and send ONE reply
 * after a human approves it in the terminal.
 *
 *   HEPSON_API_KEY=hep_... HEPSON_ACCOUNT_ID=<uuid> pnpm example
 * (HEPSON_URL defaults to http://127.0.0.1:8787)
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const base = process.env.HEPSON_URL ?? 'http://127.0.0.1:8787';
const key = process.env.HEPSON_API_KEY;
const accountId = process.env.HEPSON_ACCOUNT_ID;
if (!key || !accountId) {
  console.error('set HEPSON_API_KEY and HEPSON_ACCOUNT_ID');
  process.exit(1);
}
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const rl = createInterface({ input: process.stdin, output: process.stdout });

let last = Number(process.env.HEPSON_AFTER_SEQUENCE ?? 0);
console.log(`listening for message.received on ${accountId} (after sequence ${last}) …`);
for (;;) {
  try {
    const res = await fetch(`${base}/v1/accounts/${accountId}/events/stream?afterSequence=${last}`, { headers });
    if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status} ${await res.text()}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6)) as { sequence: number; type: string; payload: { message?: { conversationId: string; text: string | null; attachments: unknown[] } } };
        last = ev.sequence;
        if (ev.type !== 'message.received' || !ev.payload.message) continue;
        const m = ev.payload.message;
        console.log(`\nNEW: ${m.text ?? `[non-text content: ${m.attachments.length} attachment(s)]`}`);
        const reply = (await rl.question('Reply (empty = skip): ')).trim();
        if (!reply) continue;
        if ((await rl.question(`Send "${reply}" for real? [y/N] `)).trim().toLowerCase() !== 'y') continue;
        const r = await fetch(`${base}/v1/accounts/${accountId}/conversations/${m.conversationId}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: reply, idempotencyKey: randomUUID() }),
        });
        console.log(r.status, await r.text()); // 202 + outboxId; poll GET /outbox/:id for the final status
      }
    }
  } catch (e) {
    console.error((e as Error).message);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
