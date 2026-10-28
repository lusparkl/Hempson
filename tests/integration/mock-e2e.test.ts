import { afterEach, describe, expect, it } from 'vitest';
import { call, makeApp, mockAccount, type TestApp } from '../helpers';

let a: TestApp;
afterEach(async () => { await a?.close(); a?.cleanup(); });

async function firstConv(accountId: string) {
  await a.svc.syncOnce(accountId);
  const r = await call(a, a.admin, 'GET', `/v1/accounts/${accountId}/conversations`);
  return r.body.items as Array<{ id: string; providerConversationId: string; title: string }>;
}

describe('mock end-to-end', () => {
  it('inbox -> messages -> send -> events', async () => {
    a = await makeApp();
    const id = await mockAccount(a);
    const convs = await firstConv(id);
    expect(convs.length).toBe(3);
    const olena = convs.find((c) => c.providerConversationId === 'mock-thread-olena')!;
    const msgs = await call(a, a.admin, 'GET', `/v1/accounts/${id}/conversations/${olena.id}/messages`);
    expect(msgs.body.items.map((m: any) => m.direction)).toEqual(['incoming', 'outgoing', 'incoming']);

    await call(a, a.admin, 'PATCH', `/v1/accounts/${id}/settings`, { outboundEnabled: true });
    const send = await call(a, a.admin, 'POST', `/v1/accounts/${id}/conversations/${olena.id}/messages`, { text: 'Доставка 1-2 дні.', idempotencyKey: 'key-0001-aaaa' });
    expect(send.status).toBe(202);
    await a.svc.whenSendsIdle(id);
    const ob = await call(a, a.admin, 'GET', `/v1/accounts/${id}/outbox/${send.body.outboxId}`);
    expect(ob.body.status).toBe('sent');
    const ev = await call(a, a.admin, 'GET', `/v1/accounts/${id}/events`);
    const types = ev.body.items.map((e: any) => e.type);
    expect(types).toContain('session.connected');
    expect(types).toContain('message.sent');
    const seqs = ev.body.items.map((e: any) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });

  it('SSE streams replay then live events in order', async () => {
    a = await makeApp();
    const id = await mockAccount(a);
    await a.svc.syncOnce(id);
    await a.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (a.app.server.address() as any).port;
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/accounts/${id}/events/stream?afterSequence=0`, { headers: { authorization: `Bearer ${a.admin}` }, signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const seen: number[] = [];
    const pump = async (until: (n: number[]) => boolean) => {
      while (!until(seen)) {
        const { value } = await reader.read();
        buf += dec.decode(value);
        for (const m of buf.matchAll(/^id: (\d+)$/gm)) { const n = Number(m[1]); if (!seen.includes(n)) seen.push(n); }
      }
    };
    await pump((s) => s.length >= 1);
    const first = seen.length;
    await call(a, a.admin, 'POST', `/v1/dev/accounts/${id}/inject-incoming`, { providerConversationId: 'mock-thread-iryna', text: 'Привіт' });
    await pump((s) => s.length > first);
    ctrl.abort();
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(seen.length);
  });
});
