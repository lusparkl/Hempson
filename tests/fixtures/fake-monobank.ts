// Fake Monobank acquiring API. Paths, headers, fields and the webhook signature scheme are written from Monobank's public
// acquiring documentation (monobank.ua/api-docs/acquiring): `X-Token` auth, `POST /api/merchant/invoice/create`,
// `GET /api/merchant/invoice/status`, `POST /api/merchant/invoice/remove`, `GET /api/merchant/pubkey` (base64 of a PEM
// ECDSA key), `GET /api/merchant/details`, webhook body = status schema, `x-sign` = base64 DER ECDSA/SHA-256 of the body.
// Not captured from a live or test token.
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

export const MONO_TOKEN = 'uTestAcquiringToken_0123456789abcdefABCDEF';
const BASE = 'https://api.monobank.ua';

type Invoice = { invoiceId: string; amount: number; ccy: number; status: string; createdDate: string; modifiedDate: string; reference: string | null; destination: string | null; webHookUrl: string | null; validity: number | null };
type Call = { method: string; path: string; token: string | null; body: any };

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

export function newEcKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, pubKeyBase64: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }) as string).toString('base64') };
}
/** As Monobank signs a webhook: ECDSA over SHA-256 of the exact body bytes, DER, base64. */
export const signBody = (body: string, key: KeyObject) => createSign('SHA256').update(body).sign(key).toString('base64');

export function fakeMonobank() {
  let seq = 0;
  let clock = Date.parse('2026-11-01T10:00:00Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  const m = {
    calls: [] as Call[],
    invoices: new Map<string, Invoice>(),
    validTokens: new Set([MONO_TOKEN]),
    key: newEcKey(),
    /** Override one path to simulate failures: return a Response, or throw for "no answer". */
    override: new Map<string, (c: Call) => Response | Promise<Response>>(),
    /** Changes an invoice at "Monobank" (as a payment would) and returns that new status. */
    setStatus(invoiceId: string, status: string, over: Partial<Invoice> = {}): Record<string, unknown> {
      const inv = m.invoices.get(invoiceId)!;
      Object.assign(inv, { status, modifiedDate: tick(), ...over });
      return m.statusBody(inv);
    },
    statusBody(inv: Invoice): Record<string, unknown> {
      return { invoiceId: inv.invoiceId, status: inv.status, amount: inv.amount, ccy: inv.ccy, finalAmount: inv.status === 'success' ? inv.amount : 0, createdDate: inv.createdDate, modifiedDate: inv.modifiedDate, reference: inv.reference, destination: inv.destination, cancelList: [] };
    },
    /** A webhook as Monobank would send it, signed with the current key (or another key). */
    webhook(body: Record<string, unknown>, key?: KeyObject): { raw: string; sign: string } {
      const raw = JSON.stringify(body);
      return { raw, sign: signBody(raw, key ?? m.key.privateKey) };
    },
    rotateKey(): void {
      m.key = newEcKey();
    },
    only(path: string): Call[] {
      return m.calls.filter((c) => c.path.startsWith(path));
    },
    fetchFor(other?: typeof fetch): typeof fetch {
      return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith(`${BASE}/`)) {
          if (other) return other(input, init);
          throw new Error(`unexpected url ${url}`);
        }
        const u = new URL(url);
        const headers = new Headers(init?.headers);
        const c: Call = { method: init?.method ?? 'GET', path: u.pathname, token: headers.get('x-token'), body: init?.body ? JSON.parse(String(init.body)) : null };
        m.calls.push(c);
        const o = m.override.get(u.pathname);
        if (o) return o(c);
        if (!c.token || !m.validTokens.has(c.token)) return json({ errCode: 'FORBIDDEN', errText: 'forbidden' }, 403);
        switch (`${c.method} ${u.pathname}`) {
          case 'GET /api/merchant/details':
            return json({ merchantId: '12o4Vv7EWy', merchantName: 'ФОП Тест', edrpou: '4242424242' });
          case 'GET /api/merchant/pubkey':
            return json({ key: m.key.pubKeyBase64 });
          case 'POST /api/merchant/invoice/create': {
            const b = c.body;
            if (!Number.isInteger(b.amount) || b.amount <= 0) return json({ errCode: 'BAD_REQUEST', errText: 'invalid amount' }, 400);
            const invoiceId = `p2_test${++seq}`;
            const ts = tick();
            m.invoices.set(invoiceId, { invoiceId, amount: b.amount, ccy: b.ccy ?? 980, status: 'created', createdDate: ts, modifiedDate: ts, reference: b.merchantPaymInfo?.reference ?? null, destination: b.merchantPaymInfo?.destination ?? null, webHookUrl: b.webHookUrl ?? null, validity: b.validity ?? null });
            return json({ invoiceId, pageUrl: `https://pay.mbnk.biz/${invoiceId}` });
          }
          case 'GET /api/merchant/invoice/status': {
            const inv = m.invoices.get(u.searchParams.get('invoiceId') ?? '');
            return inv ? json(m.statusBody(inv)) : json({ errCode: 'NOT_FOUND', errText: 'invoice not found' }, 404);
          }
          case 'POST /api/merchant/invoice/remove': {
            const inv = m.invoices.get(c.body?.invoiceId);
            if (!inv) return json({ errCode: 'NOT_FOUND', errText: 'invoice not found' }, 404);
            inv.status = 'expired';
            inv.modifiedDate = tick();
            return new Response(null, { status: 200 });
          }
          default:
            return json({ errCode: 'NOT_FOUND', errText: 'no such method' }, 404);
        }
      }) as typeof fetch;
    },
  };
  return m;
}
export type FakeMono = ReturnType<typeof fakeMonobank>;
