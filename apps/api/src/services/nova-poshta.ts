import { EgressDeniedError } from './egress';

/**
 * A Nova Poshta call failed. Carries short codes only, never the API key or NP's message text (it can echo customer data).
 * `auth`: the key was refused. `rejected`: NP answered `success: false`. `unavailable`: no usable answer (network,
 * timeout, 5xx, unparsable body): for a write the request may still have been processed.
 */
export class NovaPoshtaError extends Error {
  constructor(
    readonly kind: 'auth' | 'rejected' | 'unavailable',
    readonly codes: string[] = [],
  ) {
    super(`nova poshta ${kind}${codes.length ? ` (${codes.join(',')})` : ''}`);
    this.name = 'NovaPoshtaError';
  }
}

export type NpCity = { ref: string; name: string; area: string | null };
export type NpWarehouse = { ref: string; cityRef: string; number: string | null; name: string };
export type NpTracking = { ttn: string; code: string; text: string };
export type NpTtnInput = {
  sender: { ref: string; contactRef: string; phone: string; cityRef: string; warehouseRef: string };
  recipient: { firstName: string; lastName: string; phone: string; cityRef: string; warehouseRef: string };
  /** Declared value and cash-on-delivery amount in hryvnias (`1299` or `1299.50`), server-computed from the order. */
  costUah: string;
  cod: boolean;
  weightKg: string;
  description: string;
  /** dd.mm.yyyy, Kyiv date. */
  date: string;
};

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** NP phones are written without the plus. */
const npPhone = (e164: string) => e164.replace(/^\+/, '');
/** Error codes only, digits; NP's error strings are never kept. */
const codesOf = (b: Json) => strs(b.errorCodes).filter((c) => /^\d{1,12}$/.test(c)).slice(0, 5);
/** How a refused key shows up in NP answers, as understood from the documentation (to verify with a live key). */
const AUTH_TEXT = /api ?key|apikey|auth/i;

/**
 * Nova Poshta JSON API 2.0 over the egress `fetch` (D22). Every call takes one shop's key; nothing here stores it.
 * Method names, parameters and response fields follow NP's public API documentation and are not yet confirmed live.
 */
export class NovaPoshtaApi {
  constructor(
    private fetchImpl: typeof fetch,
    private baseUrl = 'https://api.novaposhta.ua/v2.0/json/',
    private timeoutMs = 15_000,
  ) {}

  private async call(apiKey: string, modelName: string, calledMethod: string, methodProperties: Json): Promise<Json[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey, modelName, calledMethod, methodProperties }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof EgressDeniedError) throw e;
      throw new NovaPoshtaError('unavailable');
    }
    if (res.status >= 500 || res.status === 429) throw new NovaPoshtaError('unavailable', [`HTTP_${res.status}`]);
    let body: Json;
    try {
      body = asObj(await res.json());
    } catch {
      throw new NovaPoshtaError('unavailable', ['BAD_BODY']);
    }
    if (res.status === 401 || res.status === 403) throw new NovaPoshtaError('auth', [`HTTP_${res.status}`]);
    if (body.success !== true) {
      const errors = strs(body.errors);
      throw new NovaPoshtaError(errors.some((e) => AUTH_TEXT.test(e)) ? 'auth' : 'rejected', codesOf(body));
    }
    return Array.isArray(body.data) ? body.data.map(asObj) : [];
  }

  /** Cities whose name starts with or contains `q` (Ukrainian or Russian spelling). */
  async searchCities(apiKey: string, q: string, limit = 5): Promise<NpCity[]> {
    const data = await this.call(apiKey, 'Address', 'getCities', { FindByString: q, Limit: String(limit), Page: '1' });
    return data.flatMap((c) => {
      const ref = str(c.Ref);
      const name = str(c.Description);
      return ref && name ? [{ ref, name, area: str(c.AreaDescription) }] : [];
    });
  }

  /** Branches and parcel lockers of a city, filtered by number or address text. Only working ones are returned. */
  async searchWarehouses(apiKey: string, cityRef: string, q: string, limit = 5): Promise<NpWarehouse[]> {
    const data = await this.call(apiKey, 'Address', 'getWarehouses', { CityRef: cityRef, FindByString: q, Limit: String(limit * 2), Page: '1' });
    return data
      .flatMap((w) => {
        const ref = str(w.Ref);
        const name = str(w.Description);
        const status = str(w.WarehouseStatus);
        if (!ref || !name || (status && status !== 'Working')) return [];
        return [{ ref, cityRef: str(w.CityRef) ?? cityRef, number: str(w.Number), name }];
      })
      .slice(0, limit);
  }

  /** The key owner's sender counterparty and its first contact person (refs and phone), needed for every TTN. */
  async senderIdentity(apiKey: string): Promise<{ senderRef: string; contactRef: string | null; phone: string | null }> {
    const senders = await this.call(apiKey, 'Counterparty', 'getCounterparties', { CounterpartyProperty: 'Sender', Page: '1' });
    const senderRef = str(senders[0]?.Ref);
    if (!senderRef) throw new NovaPoshtaError('rejected', ['NO_SENDER']);
    const contacts = await this.call(apiKey, 'Counterparty', 'getCounterpartyContactPersons', { Ref: senderRef, Page: '1' });
    const phone = str(contacts[0]?.Phones);
    return { senderRef, contactRef: str(contacts[0]?.Ref), phone: phone ? `+${phone.replace(/\D/g, '')}` : null };
  }

  /** A private-person recipient. Creates no parcel, so a failure here is always safe to retry. */
  async createRecipient(apiKey: string, r: { firstName: string; lastName: string; phone: string }): Promise<{ ref: string; contactRef: string }> {
    const data = await this.call(apiKey, 'Counterparty', 'save', {
      FirstName: r.firstName,
      LastName: r.lastName,
      MiddleName: '',
      Phone: npPhone(r.phone),
      Email: '',
      CounterpartyType: 'PrivatePerson',
      CounterpartyProperty: 'Recipient',
    });
    const ref = str(data[0]?.Ref);
    const contacts = asObj(data[0]?.ContactPerson).data;
    const contactRef = str(asObj(Array.isArray(contacts) ? contacts[0] : undefined).Ref);
    if (!ref || !contactRef) throw new NovaPoshtaError('rejected', ['NO_RECIPIENT_REF']);
    return { ref, contactRef };
  }

  /**
   * Creates the express waybill (TTN), branch to branch, recipient pays delivery. One attempt: NP has no idempotency
   * key, so a call without a usable answer throws `unavailable` and the caller must treat it as uncertain.
   */
  async createTtn(apiKey: string, recipient: { ref: string; contactRef: string }, p: NpTtnInput): Promise<{ ttn: string; ref: string }> {
    const data = await this.call(apiKey, 'InternetDocument', 'save', {
      PayerType: 'Recipient',
      PaymentMethod: 'Cash',
      DateTime: p.date,
      CargoType: 'Parcel',
      Weight: p.weightKg,
      ServiceType: 'WarehouseWarehouse',
      SeatsAmount: '1',
      Description: p.description,
      Cost: p.costUah,
      CitySender: p.sender.cityRef,
      Sender: p.sender.ref,
      SenderAddress: p.sender.warehouseRef,
      ContactSender: p.sender.contactRef,
      SendersPhone: npPhone(p.sender.phone),
      CityRecipient: p.recipient.cityRef,
      Recipient: recipient.ref,
      RecipientAddress: p.recipient.warehouseRef,
      ContactRecipient: recipient.contactRef,
      RecipientsPhone: npPhone(p.recipient.phone),
      ...(p.cod ? { BackwardDeliveryData: [{ PayerType: 'Recipient', CargoType: 'Money', RedeliveryString: p.costUah }] } : {}),
    });
    const ttn = str(data[0]?.IntDocNumber);
    const ref = str(data[0]?.Ref);
    // success without a number: the parcel may exist, so this is uncertain, not a refusal.
    if (!ttn || !ref || !/^\d{10,20}$/.test(ttn)) throw new NovaPoshtaError('unavailable', ['NO_TTN_IN_ANSWER']);
    return { ttn, ref };
  }

  /** Current status of up to 100 TTNs. The phone (sender's or recipient's) is required for the full status. */
  async track(apiKey: string, docs: Array<{ ttn: string; phone: string }>): Promise<NpTracking[]> {
    if (!docs.length) return [];
    const data = await this.call(apiKey, 'TrackingDocument', 'getStatusDocuments', { Documents: docs.slice(0, 100).map((d) => ({ DocumentNumber: d.ttn, Phone: npPhone(d.phone) })) });
    return data.flatMap((d) => {
      const ttn = str(d.Number);
      const code = d.StatusCode === undefined || d.StatusCode === null ? null : String(d.StatusCode);
      return ttn && code && /^\d{1,4}$/.test(code) ? [{ ttn, code, text: str(d.Status) ?? '' }] : [];
    });
  }
}

/**
 * Tracking status codes, from NP's published status list (to confirm against live parcels). Delivered: received (9),
 * received with a money transfer pending or paid out (10, 11), received with a return-delivery document (106).
 * Returning: refused by the recipient (102, 103) or storage ended (105, not counted as a refusal).
 */
export function trackingOutcome(code: string): { outcome: 'delivered' | 'returning' | null; refusal: boolean } {
  if (['9', '10', '11', '106'].includes(code)) return { outcome: 'delivered', refusal: false };
  if (code === '102' || code === '103') return { outcome: 'returning', refusal: true };
  if (code === '105') return { outcome: 'returning', refusal: false };
  return { outcome: null, refusal: false };
}
