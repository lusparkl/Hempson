import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MonobankApi, MonobankError, parseInvoiceStatus, verifyMonobankSignature } from '../../apps/api/src/services/monobank';
import { MONO_TOKEN, fakeMonobank, newEcKey, signBody } from '../fixtures/fake-monobank';

// Signature fixtures follow Monobank's documented scheme (webhooks/verify): the public key is base64 of a PEM block, the
// `x-sign` header is base64 of a DER ECDSA signature over SHA-256 of the raw body. Keys are generated per test run.
describe('verifyMonobankSignature', () => {
  const k = newEcKey();
  const body = JSON.stringify({ invoiceId: 'p2_9ZgpZVsl3', status: 'success', amount: 4200, ccy: 980, modifiedDate: '2026-11-01T10:00:00Z' });
  const sig = signBody(body, k.privateKey);

  it('accepts the exact body signed with the merchant key', () => {
    expect(verifyMonobankSignature(Buffer.from(body), sig, k.pubKeyBase64)).toBe(true);
  });
  it('refuses a changed body, a re-serialized body, another key, a missing or garbage header', () => {
    expect(verifyMonobankSignature(Buffer.from(body.replace('4200', '1')), sig, k.pubKeyBase64)).toBe(false);
    expect(verifyMonobankSignature(Buffer.from(JSON.stringify(JSON.parse(body), null, 1)), sig, k.pubKeyBase64)).toBe(false);
    expect(verifyMonobankSignature(Buffer.from(body), sig, newEcKey().pubKeyBase64)).toBe(false);
    expect(verifyMonobankSignature(Buffer.from(body), undefined, k.pubKeyBase64)).toBe(false);
    expect(verifyMonobankSignature(Buffer.from(body), 'not base64 !!', k.pubKeyBase64)).toBe(false);
    expect(verifyMonobankSignature(Buffer.from(body), sig, null)).toBe(false);
    expect(verifyMonobankSignature(Buffer.from(body), sig, Buffer.from('garbage').toString('base64'))).toBe(false);
  });
  it('refuses a non-EC key even if the signature would verify with it', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = Buffer.from(rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string).toString('base64');
    expect(verifyMonobankSignature(Buffer.from(body), signBody(body, rsa.privateKey), pem)).toBe(false);
  });
});

describe('parseInvoiceStatus', () => {
  it('keeps the documented fields and drops anything not well-formed', () => {
    expect(parseInvoiceStatus({ invoiceId: 'p2_1', status: 'success', amount: 4200, ccy: 980, finalAmount: 4200, modifiedDate: '2026-11-01T10:00:00Z', errCode: '59', reference: 'r' })).toEqual({
      invoiceId: 'p2_1',
      status: 'success',
      amount: 4200,
      ccy: 980,
      finalAmount: 4200,
      modifiedDate: '2026-11-01T10:00:00Z',
      errCode: '59',
      reference: 'r',
    });
    expect(parseInvoiceStatus({ invoiceId: 'p2_1', status: 'paid', amount: 4200, ccy: 980 })).toBeNull();
    expect(parseInvoiceStatus({ invoiceId: 'p2_1', status: 'success', amount: 42.5, ccy: 980 })).toBeNull();
    expect(parseInvoiceStatus({ status: 'success', amount: 4200, ccy: 980 })).toBeNull();
    expect(parseInvoiceStatus({ invoiceId: 'p2_1', status: 'success', amount: 4200, ccy: 980, modifiedDate: 'yesterday', errCode: 'free text here' })).toMatchObject({ modifiedDate: null, errCode: null });
  });
});

describe('MonobankApi', () => {
  it('sends X-Token and the documented create body; never puts the token in an error', async () => {
    const m = fakeMonobank();
    const api = new MonobankApi(m.fetchFor());
    const inv = await api.createInvoice(MONO_TOKEN, { amountMinor: 259_800, ccy: 980, reference: 'order-1', destination: 'Замовлення 1', validitySec: 3600, webHookUrl: 'https://h.example/webhooks/monobank/x', redirectUrl: null });
    expect(inv).toEqual({ invoiceId: 'p2_test1', pageUrl: 'https://pay.mbnk.biz/p2_test1' });
    expect(m.calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/merchant/invoice/create',
      token: MONO_TOKEN,
      body: { amount: 259_800, ccy: 980, merchantPaymInfo: { reference: 'order-1', destination: 'Замовлення 1' }, validity: 3600, paymentType: 'debit', webHookUrl: 'https://h.example/webhooks/monobank/x' },
    });
    expect(m.calls[0]!.body).not.toHaveProperty('redirectUrl');
    expect(await api.invoiceStatus(MONO_TOKEN, inv.invoiceId)).toMatchObject({ status: 'created', amount: 259_800 });
    await api.removeInvoice(MONO_TOKEN, inv.invoiceId);

    const err = await api.merchantDetails('wrong-token-0123456789').catch((e) => e);
    expect(err).toBeInstanceOf(MonobankError);
    expect(err.kind).toBe('auth');
    expect(String(err.message)).not.toContain('wrong-token');
  });
  it('maps 4xx to rejected (short code only), 429/5xx/network/empty create answer to unavailable', async () => {
    const m = fakeMonobank();
    const api = new MonobankApi(m.fetchFor());
    const kind = (p: Promise<unknown>) => p.then(() => 'ok', (e: MonobankError) => `${e.kind}:${e.code}`);
    expect(await kind(api.createInvoice(MONO_TOKEN, { amountMinor: 0, ccy: 980, reference: 'r', destination: 'd', validitySec: 60, webHookUrl: null, redirectUrl: null }))).toBe('rejected:BAD_REQUEST');
    m.override.set('/api/merchant/invoice/create', () => new Response('{"errText":"Внутрішня помилка"}', { status: 500 }));
    expect(await kind(api.createInvoice(MONO_TOKEN, { amountMinor: 1, ccy: 980, reference: 'r', destination: 'd', validitySec: 60, webHookUrl: null, redirectUrl: null }))).toBe('unavailable:HTTP_500');
    m.override.set('/api/merchant/invoice/create', () => new Response('{}', { status: 200 }));
    expect(await kind(api.createInvoice(MONO_TOKEN, { amountMinor: 1, ccy: 980, reference: 'r', destination: 'd', validitySec: 60, webHookUrl: null, redirectUrl: null }))).toBe('unavailable:NO_INVOICE_IN_ANSWER');
    m.override.set('/api/merchant/invoice/create', () => Promise.reject(new TypeError('socket hang up')));
    expect(await kind(api.createInvoice(MONO_TOKEN, { amountMinor: 1, ccy: 980, reference: 'r', destination: 'd', validitySec: 60, webHookUrl: null, redirectUrl: null }))).toBe('unavailable:null');
    m.override.set('/api/merchant/details', () => new Response('{"errCode":"x y z"}', { status: 429 }));
    expect(await kind(api.merchantDetails(MONO_TOKEN))).toBe('unavailable:HTTP_429');
  });
});
