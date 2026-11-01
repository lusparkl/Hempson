import { createPublicKey, createVerify } from 'node:crypto';
import { PROVIDER_STATUSES, type ProviderStatus } from '@hepson/database';
import { EgressDeniedError } from './egress';

/**
 * A Monobank acquiring call failed. Carries short codes only, never the token or Monobank's error text.
 * `auth`: the token was refused (HTTP 403). `rejected`: Monobank answered 4xx for the request itself. `unavailable`: no
 * usable answer (network, timeout, 429, 5xx, unparsable body): for a create call the invoice may still exist.
 */
export class MonobankError extends Error {
  constructor(
    readonly kind: 'auth' | 'rejected' | 'unavailable',
    readonly code: string | null = null,
  ) {
    super(`monobank ${kind}${code ? ` (${code})` : ''}`);
    this.name = 'MonobankError';
  }
}

export type MonoInvoiceStatus = {
  invoiceId: string;
  status: ProviderStatus;
  amount: number;
  ccy: number;
  finalAmount: number | null;
  modifiedDate: string | null;
  errCode: string | null;
  reference: string | null;
};

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
/** Monobank's API error codes are short tokens; anything else is dropped so provider text never reaches logs. */
const shortCode = (v: unknown) => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  return /^[A-Za-z0-9_]{1,32}$/.test(s) ? s : null;
};

/**
 * Parses an invoice status as Monobank sends it (status response and webhook body share the `InvoiceStatusResponse`
 * schema). Returns null for anything that is not a well-formed status: unknown status, missing id, non-integer amount.
 */
export function parseInvoiceStatus(v: unknown): MonoInvoiceStatus | null {
  const b = asObj(v);
  const invoiceId = str(b.invoiceId);
  const status = str(b.status);
  const amount = int(b.amount);
  const ccy = int(b.ccy);
  if (!invoiceId || invoiceId.length > 64 || !status || !(PROVIDER_STATUSES as readonly string[]).includes(status) || amount === null || ccy === null) return null;
  const modified = str(b.modifiedDate);
  return {
    invoiceId,
    status: status as ProviderStatus,
    amount,
    ccy,
    finalAmount: int(b.finalAmount),
    modifiedDate: modified && !Number.isNaN(Date.parse(modified)) ? modified.slice(0, 40) : null,
    errCode: shortCode(b.errCode),
    reference: str(b.reference),
  };
}

/**
 * Checks Monobank's `x-sign` header: base64 of a DER-encoded ECDSA signature over SHA-256 of the raw request body,
 * verified with the merchant public key from `GET /api/merchant/pubkey` (base64 of a PEM block). The raw bytes are
 * verified as received; a re-serialized body would not match. Never throws.
 */
export function verifyMonobankSignature(rawBody: Buffer, xSign: string | undefined, pubKeyBase64: string | null): boolean {
  if (!xSign || !pubKeyBase64 || xSign.length > 512 || !/^[A-Za-z0-9+/=]+$/.test(xSign)) return false;
  try {
    const key = createPublicKey(Buffer.from(pubKeyBase64, 'base64').toString('utf8'));
    if (key.asymmetricKeyType !== 'ec') return false;
    const v = createVerify('SHA256');
    v.update(rawBody);
    v.end();
    return v.verify({ key, dsaEncoding: 'der' }, Buffer.from(xSign, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Monobank acquiring ("plata by mono") over the egress `fetch` (D22). Every call takes one shop's token (`X-Token`);
 * nothing here stores it. Paths and fields follow Monobank's public acquiring documentation (monobank.ua/api-docs/acquiring)
 * and are not yet confirmed against a live or test token.
 */
export class MonobankApi {
  constructor(
    private fetchImpl: typeof fetch,
    private baseUrl = 'https://api.monobank.ua',
    private timeoutMs = 15_000,
  ) {}

  private async call(token: string, method: 'GET' | 'POST', path: string, body?: Json): Promise<Json> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { 'x-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof EgressDeniedError) throw e;
      throw new MonobankError('unavailable');
    }
    if (res.status >= 500 || res.status === 429) throw new MonobankError('unavailable', `HTTP_${res.status}`);
    const text = await res.text().catch(() => null);
    if (text === null) throw new MonobankError('unavailable', 'BAD_BODY');
    let json: Json = {};
    if (text.trim()) {
      try {
        json = asObj(JSON.parse(text));
      } catch {
        if (res.ok) throw new MonobankError('unavailable', 'BAD_BODY');
      }
    }
    if (res.status === 401 || res.status === 403) throw new MonobankError('auth', `HTTP_${res.status}`);
    if (!res.ok) throw new MonobankError('rejected', shortCode(json.errCode) ?? `HTTP_${res.status}`);
    return json;
  }

  /** The merchant the token belongs to; used to check a token before it is stored. */
  async merchantDetails(token: string): Promise<{ merchantId: string; merchantName: string | null }> {
    const b = await this.call(token, 'GET', '/api/merchant/details');
    const merchantId = str(b.merchantId);
    if (!merchantId) throw new MonobankError('rejected', 'NO_MERCHANT');
    return { merchantId: merchantId.slice(0, 64), merchantName: str(b.merchantName)?.slice(0, 200) ?? null };
  }

  /** The public key that verifies webhook signatures (base64 of a PEM block). Cached by the caller. */
  async pubKey(token: string): Promise<string> {
    const key = str((await this.call(token, 'GET', '/api/merchant/pubkey')).key);
    if (!key || key.length > 4096) throw new MonobankError('rejected', 'NO_KEY');
    return key;
  }

  /**
   * Creates an invoice for the given amount (minor units) and returns its id and payment page. One attempt: a call without
   * a usable answer throws `unavailable`, and the caller treats the invoice as unknown (its link was never seen by anyone).
   */
  async createInvoice(
    token: string,
    p: { amountMinor: number; ccy: number; reference: string; destination: string; validitySec: number; webHookUrl: string | null; redirectUrl: string | null },
  ): Promise<{ invoiceId: string; pageUrl: string }> {
    const b = await this.call(token, 'POST', '/api/merchant/invoice/create', {
      amount: p.amountMinor,
      ccy: p.ccy,
      merchantPaymInfo: { reference: p.reference, destination: p.destination },
      validity: p.validitySec,
      paymentType: 'debit',
      ...(p.webHookUrl ? { webHookUrl: p.webHookUrl } : {}),
      ...(p.redirectUrl ? { redirectUrl: p.redirectUrl } : {}),
    });
    const invoiceId = str(b.invoiceId);
    const pageUrl = str(b.pageUrl);
    if (!invoiceId || !pageUrl || !/^https:\/\//.test(pageUrl) || invoiceId.length > 64) throw new MonobankError('unavailable', 'NO_INVOICE_IN_ANSWER');
    return { invoiceId, pageUrl };
  }

  async invoiceStatus(token: string, invoiceId: string): Promise<MonoInvoiceStatus> {
    const s = parseInvoiceStatus(await this.call(token, 'GET', `/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`));
    if (!s || s.invoiceId !== invoiceId) throw new MonobankError('unavailable', 'BAD_STATUS');
    return s;
  }

  /** Deactivates an unpaid invoice (the page stops accepting payments). Monobank answers 200 with an empty body. */
  async removeInvoice(token: string, invoiceId: string): Promise<void> {
    await this.call(token, 'POST', '/api/merchant/invoice/remove', { invoiceId });
  }
}
