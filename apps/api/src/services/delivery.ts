import { ConnectorError } from '@hepson/connector-core';
import {
  CredentialDecryptError,
  CredentialMissingError,
  CredentialsUnavailableError,
  OrderStateError,
  type CredentialVault,
  type DeliveryRepository,
  type OrderDraft,
  type OrderDraftRow,
  type OrderRepository,
} from '@hepson/database';
import { EgressDeniedError } from './egress';
import type { Notifier } from './notifier';
import { NovaPoshtaError, trackingOutcome, type NovaPoshtaApi, type NpCity, type NpWarehouse } from './nova-poshta';

type Logger = { info(o: object, m?: string): void; warn(o: object, m?: string): void };

/** NP API keys are 32 hex characters (as issued in the NP business cabinet). Checked before any call. */
const KEY_RE = /^[0-9a-f]{32}$/i;

export type DeliveryServiceDeps = {
  api: NovaPoshtaApi;
  vault: CredentialVault;
  repo: DeliveryRepository;
  orders: OrderRepository;
  log: Logger;
  notifier?: Notifier;
  clock?: () => Date;
};

/** Kyiv calendar date as NP wants it (dd.mm.yyyy). */
function kyivDate(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year}`;
}
const uah = (minor: number) => (minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2));

/**
 * Nova Poshta for one shop at a time (P4): the shop's own API key (vault kind `nova_poshta`, D28), city and branch
 * lookups for checkout, TTN creation for COD orders, and tracking that moves `shipped` orders to `delivered` or
 * `returning`. TTN numbers and statuses are stored only as NP returned them.
 */
export class DeliveryService {
  private inflight = new Set<Promise<unknown>>();
  constructor(private d: DeliveryServiceDeps) {}

  private now() {
    return (this.d.clock ?? (() => new Date()))();
  }
  get available(): boolean {
    return this.d.vault.available;
  }
  connected(shopId: string): boolean {
    return this.available && this.d.vault.get(shopId, 'nova_poshta')?.status === 'active';
  }

  /** Non-secret state for the dashboard. */
  status(shopId: string) {
    const s = this.d.repo.getSettings(shopId);
    const cred = this.available ? this.d.vault.get(shopId, 'nova_poshta') : undefined;
    return {
      available: this.available,
      status: cred ? (cred.status === 'active' ? ('connected' as const) : ('needs_reconnect' as const)) : ('not_connected' as const),
      senderReady: this.d.repo.senderComplete(s),
      senderPhone: s.senderPhone,
      senderCityRef: s.senderCityRef,
      senderCityName: s.senderCityName,
      senderWarehouseRef: s.senderWarehouseRef,
      senderWarehouseName: s.senderWarehouseName,
      codEnabled: s.codEnabled,
      prepaidEnabled: s.prepaidEnabled,
      refusalLimit: s.refusalLimit,
      parcelWeightKg: s.parcelWeightKg,
      parcelDescription: s.parcelDescription,
      lastError: s.lastError,
      updatedAt: s.updatedAt || null,
    };
  }

  /** Runs one NP call with the shop's key. A refused key marks the credential and tells the owner once. */
  private async withKey<T>(shopId: string, fn: (key: string) => Promise<T>): Promise<T> {
    if (!this.available) throw new ConnectorError('NOT_CONFIGURED', 'Credential storage is not configured on this server');
    if (!this.connected(shopId)) throw new ConnectorError('NOT_CONFIGURED', 'Nova Poshta is not connected for this shop');
    try {
      return await this.d.vault.withSecret(shopId, 'nova_poshta', fn);
    } catch (e) {
      if (e instanceof NovaPoshtaError && e.kind === 'auth') {
        this.d.vault.mark(shopId, 'nova_poshta', 'needs_reconnect');
        this.d.repo.setLastError(shopId, 'KEY_REJECTED');
        this.d.notifier?.notify({ kind: 'channel_issue', shopId, channel: 'nova_poshta', issue: 'needs_reconnect' });
      }
      if (e instanceof CredentialMissingError || e instanceof CredentialsUnavailableError || e instanceof CredentialDecryptError) throw new ConnectorError('NOT_CONFIGURED', 'Nova Poshta is not connected for this shop');
      throw e;
    }
  }

  private translate(e: unknown): never {
    if (e instanceof NovaPoshtaError) {
      if (e.kind === 'auth') throw new ConnectorError('VALIDATION_ERROR', 'Nova Poshta did not accept the API key');
      if (e.kind === 'unavailable') throw new ConnectorError('TEMPORARY_FAILURE', 'Nova Poshta is not reachable, try again');
      throw new ConnectorError('VALIDATION_ERROR', 'Nova Poshta refused the request');
    }
    throw e;
  }

  /** Checks the key by reading the sender identity, then stores the key encrypted and the sender refs in settings. */
  async connect(shopId: string, apiKey: string): Promise<ReturnType<DeliveryService['status']>> {
    if (!this.available) throw new ConnectorError('NOT_CONFIGURED', 'Credential storage is not configured on this server');
    if (!KEY_RE.test(apiKey)) throw new ConnectorError('VALIDATION_ERROR', 'This is not a Nova Poshta API key');
    try {
      const me = await this.d.api.senderIdentity(apiKey);
      this.d.repo.db.transaction(() => {
        this.d.vault.save(shopId, 'nova_poshta', apiKey);
        this.d.repo.setSender(shopId, { senderRef: me.senderRef, senderContactRef: me.contactRef, senderPhone: me.phone });
      });
      this.d.log.info({ shopId }, 'nova poshta connected');
      return this.status(shopId);
    } catch (e) {
      if (e instanceof NovaPoshtaError) this.d.log.warn({ shopId, kind: e.kind, codes: e.codes }, 'nova poshta connect failed');
      this.translate(e);
    }
  }

  disconnect(shopId: string): void {
    if (this.available) this.d.vault.delete(shopId, 'nova_poshta');
  }

  async cities(shopId: string, q: string): Promise<NpCity[]> {
    try {
      return await this.withKey(shopId, (k) => this.d.api.searchCities(k, q));
    } catch (e) {
      this.translate(e);
    }
  }

  async warehouses(shopId: string, cityRef: string, q: string): Promise<NpWarehouse[]> {
    try {
      return await this.withKey(shopId, (k) => this.d.api.searchWarehouses(k, cityRef, q));
    } catch (e) {
      this.translate(e);
    }
  }

  /** Fire and forget after an approval: a COD order gets its TTN; a prepaid one waits for `paid` (`afterPaid`). */
  afterApproval(shopId: string, d: OrderDraft): void {
    if (d.draft.status !== 'cod_confirmed') return;
    this.track(this.createTtn(shopId, d.draft.id).catch(() => undefined));
  }

  /** Fire and forget after a verified payment (P5): a prepaid order gets its TTN from `paid` (D25). */
  afterPaid(shopId: string, draftId: string): void {
    const d = this.d.orders.getDraft(shopId, draftId)?.draft;
    if (!d || d.status !== 'paid') return;
    if (!this.connected(shopId) || !this.d.repo.senderComplete(this.d.repo.getSettings(shopId))) {
      this.d.notifier?.notify({ kind: 'order_update', shopId, conversationId: d.conversationId, draftId, event: 'ttn_failed', ttn: null });
      return;
    }
    this.track(this.createTtn(shopId, draftId).catch(() => undefined));
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }

  /** Resolves when no TTN creation or tracking pass is in flight (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /**
   * Creates the TTN at most once per order: the DB claim comes first, then the recipient, then one `InternetDocument.save`.
   * A refusal leaves the order retryable (`failed`); no answer leaves it `uncertain` and the shop checks the NP cabinet.
   */
  async createTtn(shopId: string, draftId: string): Promise<OrderDraft> {
    const { orders, repo, log } = this.d;
    const settings = repo.getSettings(shopId);
    if (!this.connected(shopId)) throw new ConnectorError('NOT_CONFIGURED', 'Nova Poshta is not connected for this shop');
    if (!repo.senderComplete(settings)) throw new ConnectorError('VALIDATION_ERROR', 'Set the sender city and branch in the Nova Poshta settings first');
    let d: OrderDraftRow;
    try {
      d = orders.claimTtn(shopId, draftId).draft;
    } catch (e) {
      if (e instanceof OrderStateError) throw new ConnectorError('VALIDATION_ERROR', e.message);
      throw e;
    }
    const fail = (state: 'failed' | 'uncertain', code: string) => {
      orders.failTtn(shopId, draftId, state, code);
      log.warn({ shopId, draftId, state, code }, 'nova poshta ttn not created');
      this.d.notifier?.notify({ kind: 'order_update', shopId, conversationId: d.conversationId, draftId, event: state === 'failed' ? 'ttn_failed' : 'ttn_uncertain', ttn: null });
      return orders.getDraft(shopId, draftId)!;
    };
    if (d.currency !== 'UAH') return fail('failed', 'CURRENCY_NOT_UAH');
    let sent = false;
    try {
      const res = await this.withKey(shopId, async (key) => {
        const recipient = await this.d.api.createRecipient(key, { firstName: d.recipientFirstName!, lastName: d.recipientLastName!, phone: d.recipientPhone! });
        sent = true;
        return this.d.api.createTtn(key, recipient, {
          sender: { ref: settings.senderRef!, contactRef: settings.senderContactRef!, phone: settings.senderPhone!, cityRef: settings.senderCityRef!, warehouseRef: settings.senderWarehouseRef! },
          recipient: { firstName: d.recipientFirstName!, lastName: d.recipientLastName!, phone: d.recipientPhone!, cityRef: d.npCityRef!, warehouseRef: d.npWarehouseRef! },
          costUah: uah(d.totalMinor),
          cod: d.paymentMethod === 'cod',
          weightKg: settings.parcelWeightKg,
          description: settings.parcelDescription,
          date: kyivDate(this.now()),
        });
      });
      log.info({ shopId, draftId }, 'nova poshta ttn created');
      return orders.completeTtn(shopId, draftId, { ttn: res.ttn, documentRef: res.ref });
    } catch (e) {
      // Before the document call nothing can exist at NP; after it, only a definite refusal is safe to retry.
      if (!sent || (e instanceof NovaPoshtaError && e.kind !== 'unavailable') || e instanceof EgressDeniedError || e instanceof ConnectorError)
        return fail('failed', e instanceof NovaPoshtaError ? `NP_${e.kind.toUpperCase()}${e.codes[0] ? `_${e.codes[0]}` : ''}` : e instanceof EgressDeniedError ? 'EGRESS_DENIED' : 'NP_NOT_CONNECTED');
      return fail('uncertain', e instanceof NovaPoshtaError ? `NP_NO_ANSWER${e.codes[0] ? `_${e.codes[0]}` : ''}` : 'NP_NO_ANSWER');
    }
  }

  /** One tracking pass over shipped orders, per shop with its own key, 100 TTNs per call. Safe to run repeatedly. */
  async pollOnce(): Promise<{ checked: number; transitions: number }> {
    return this.track(this.poll());
  }

  private async poll(): Promise<{ checked: number; transitions: number }> {
    const byShop = new Map<string, OrderDraftRow[]>();
    for (const o of this.d.orders.listForTracking()) byShop.set(o.shopId, [...(byShop.get(o.shopId) ?? []), o]);
    let checked = 0;
    let transitions = 0;
    for (const [shopId, list] of byShop) {
      if (!this.connected(shopId)) continue;
      for (let i = 0; i < list.length; i += 100) {
        const batch = list.slice(i, i + 100);
        let statuses;
        try {
          statuses = await this.withKey(shopId, (k) => this.d.api.track(k, batch.map((o) => ({ ttn: o.ttn!, phone: o.recipientPhone ?? '' }))));
        } catch (e) {
          this.d.log.warn({ shopId, code: e instanceof NovaPoshtaError ? e.kind : e instanceof Error ? e.name : 'ERROR' }, 'nova poshta tracking failed');
          break;
        }
        for (const st of statuses) {
          const o = batch.find((x) => x.ttn === st.ttn);
          if (!o) continue;
          checked++;
          const r = this.d.orders.applyTracking(shopId, o.id, { code: st.code, text: st.text, ...trackingOutcome(st.code) });
          if (!r.transition) continue;
          transitions++;
          if (r.transition === 'returning') this.d.notifier?.notify({ kind: 'order_update', shopId, conversationId: o.conversationId, draftId: o.id, event: 'returning', ttn: o.ttn });
        }
      }
    }
    return { checked, transitions };
  }
}
