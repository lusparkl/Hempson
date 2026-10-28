import { createHash } from 'node:crypto';
import { ConnectorError, fingerprintAll, type ConnectorStatus, type EventType, type MessagingAdapter, type ObservedMessage } from '@hepson/connector-core';
import type { AccountRow, ConversationRow, MessageRow, OutboxRow, Store } from '@hepson/database';
import type { Config } from '../config';
import type { EventBus } from './event-bus';

type Logger = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
type Worker = { timer: NodeJS.Timeout | null; running: boolean; backoff: number; stopped: boolean };

export type AdapterRegistry = Record<AccountRow['connectorType'], MessagingAdapter | undefined>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ConnectorService {
  private workers = new Map<string, Worker>();
  private sendChains = new Map<string, Promise<unknown>>();
  private sigs = new Map<string, Map<string, string>>();
  private syncing = new Map<string, Promise<void>>();
  private wired = new Set<MessagingAdapter>();
  private shuttingDown = false;

  constructor(
    readonly store: Store,
    readonly bus: EventBus,
    private adapters: AdapterRegistry,
    private cfg: Config,
    private log: Logger,
  ) {
    for (const a of Object.values(adapters)) if (a && !this.wired.has(a)) this.wire(a);
  }

  private wire(a: MessagingAdapter) {
    this.wired.add(a);
    a.onStatusChange((accountId, status, detail) => this.onAdapterStatus(accountId, status, detail));
  }

  adapterFor(acc: AccountRow): MessagingAdapter {
    const a = this.adapters[acc.connectorType];
    if (!a) throw new ConnectorError('TEMPORARY_FAILURE', `Connector '${acc.connectorType}' is not available in this deployment`, { retryable: false });
    return a;
  }

  // ---------- status ----------
  private setStatus(accountId: string, status: ConnectorStatus, code: string | null = null, extra: Partial<AccountRow> = {}) {
    const prev = this.store.getAccount(accountId);
    if (!prev) return;
    this.store.updateAccount(accountId, { status, lastErrorCode: code, ...extra });
    if (prev.status === status) return;
    const map: Partial<Record<ConnectorStatus, EventType>> = {
      connected: 'session.connected',
      login_required: 'session.login_required',
      checkpoint_required: 'session.checkpoint_required',
      degraded: 'connector.degraded',
    };
    const type = map[status];
    if (type) this.bus.emit(accountId, type, { status, code });
    else if (status === 'failed') this.bus.emit(accountId, 'connector.error', { code: code ?? 'INTERNAL', status });
  }

  private onAdapterStatus(accountId: string, status: ConnectorStatus, detail?: { code?: string; message?: string }) {
    const acc = this.store.getAccount(accountId);
    if (!acc) return;
    if (status === 'connected') {
      this.setStatus(accountId, 'connected', null, { lastAuthValidatedAt: new Date().toISOString() });
      if (acc.enabled && !acc.paused) this.startWorker(accountId);
    } else if (status === 'login_required' || status === 'checkpoint_required' || status === 'failed') {
      this.stopWorker(accountId);
      this.setStatus(accountId, status, detail?.code ?? null);
    } else {
      this.setStatus(accountId, status, detail?.code ?? null);
    }
  }

  // ---------- session lifecycle ----------
  async startSession(accountId: string, opts: { interactive: boolean }): Promise<ConnectorStatus> {
    const acc = this.mustAccount(accountId);
    if (acc.connectorType !== 'mock' && !acc.consentRecordedAt) throw new ConnectorError('CONSENT_REQUIRED', 'Shop owner consent must be recorded before a real session starts');
    const adapter = this.adapterFor(acc);
    this.store.updateAccount(accountId, { enabled: true, paused: false });
    this.setStatus(accountId, 'connecting');
    try {
      const status = await adapter.connect(accountId, {
        expectedHandle: acc.expectedInstagramHandle,
        interactiveLogin: opts.interactive,
        onHandleObserved: (h) => {
          if (!this.store.getAccount(accountId)?.expectedInstagramHandle) this.store.updateAccount(accountId, { expectedInstagramHandle: h });
        },
      });
      this.onAdapterStatus(accountId, status);
      return status;
    } catch (e) {
      const err = this.asConnectorError(e);
      const st: ConnectorStatus = err.code === 'LOGIN_REQUIRED' ? 'login_required' : err.code === 'CHECKPOINT_REQUIRED' ? 'checkpoint_required' : 'failed';
      this.stopWorker(accountId);
      this.setStatus(accountId, st, err.code);
      if (st === 'failed') this.bus.emit(accountId, 'connector.error', { code: err.code, message: err.message });
      if (err.code === 'IDENTITY_MISMATCH' || err.code === 'PROFILE_LOCKED') throw err;
      return st;
    }
  }

  async pause(accountId: string): Promise<void> {
    const acc = this.mustAccount(accountId);
    this.stopWorker(accountId);
    this.store.updateAccount(accountId, { paused: true });
    await this.adapterFor(acc).disconnect(accountId); // keeps profile
    this.setStatus(accountId, 'disconnected');
  }
  async resume(accountId: string): Promise<ConnectorStatus> {
    this.store.updateAccount(accountId, { paused: false });
    return this.startSession(accountId, { interactive: false });
  }
  async disconnect(accountId: string): Promise<void> {
    const acc = this.mustAccount(accountId);
    this.stopWorker(accountId);
    this.store.updateAccount(accountId, { enabled: false });
    await this.adapterFor(acc).disconnect(accountId);
    this.setStatus(accountId, 'disconnected');
  }
  async forgetSession(accountId: string): Promise<void> {
    const acc = this.mustAccount(accountId);
    this.stopWorker(accountId);
    await this.adapterFor(acc).forgetSession(accountId);
    this.store.updateAccount(accountId, { lastAuthValidatedAt: null, enabled: false });
    this.setStatus(accountId, 'login_required');
  }

  /** Boot: reopen every enabled, non-paused account's saved session. Never prompts for login. */
  async autostart(): Promise<void> {
    const accs = this.store.listAccounts().filter((a) => a.enabled && !a.paused && (a.connectorType === 'mock' || a.lastAuthValidatedAt));
    const real = accs.filter((a) => a.connectorType !== 'mock');
    const mock = accs.filter((a) => a.connectorType === 'mock');
    for (const a of mock)
      await this.startSession(a.id, { interactive: false }).catch((e) => this.log.warn({ accountId: a.id, code: (e as ConnectorError).code }, 'autostart failed'));
    // real browsers: bounded concurrency
    const queue = [...real];
    const workers = Array.from({ length: Math.max(1, this.cfg.maxConcurrentBrowsers) }, async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        await this.startSession(a.id, { interactive: false }).catch((e) => this.log.warn({ accountId: a.id, code: (e as ConnectorError).code }, 'autostart failed'));
      }
    });
    await Promise.all(workers);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const id of [...this.workers.keys()]) this.stopWorker(id);
    await Promise.allSettled([...this.syncing.values()]);
    await Promise.allSettled([...this.sendChains.values()]);
    await Promise.allSettled([...this.wired].map((a) => a.shutdown()));
  }

  /** Crash recovery: anything left mid-flight can never be retried automatically. */
  recoverInterruptedSends(): void {
    for (const acc of this.store.listAccounts()) {
      for (const ob of this.store.listOutbox(acc.id, ['sending'])) this.store.transitionOutbox(acc.id, ob.id, ['sending'], 'uncertain', 'INTERRUPTED_DURING_SEND');
      for (const ob of this.store.listOutbox(acc.id, ['queued'])) this.store.transitionOutbox(acc.id, ob.id, ['queued'], 'failed', 'INTERRUPTED_BEFORE_SEND');
    }
  }

  // ---------- worker ----------
  private startWorker(accountId: string) {
    if (this.shuttingDown) return;
    const existing = this.workers.get(accountId);
    if (existing && !existing.stopped) return;
    const w: Worker = { timer: null, running: false, backoff: 0, stopped: false };
    this.workers.set(accountId, w);
    const tick = async () => {
      if (w.stopped) return;
      try {
        await this.syncOnce(accountId);
        w.backoff = 0;
        const acc = this.store.getAccount(accountId);
        if (acc?.status === 'degraded') this.setStatus(accountId, 'connected');
      } catch (e) {
        const err = this.asConnectorError(e);
        this.handleSyncError(accountId, err, w);
      }
      if (!w.stopped) w.timer = setTimeout(tick, this.cfg.pollIntervalMs + w.backoff);
    };
    w.timer = setTimeout(tick, 0);
  }
  private stopWorker(accountId: string) {
    const w = this.workers.get(accountId);
    if (w) {
      w.stopped = true;
      if (w.timer) clearTimeout(w.timer);
    }
    this.workers.delete(accountId);
  }
  isWorkerRunning(accountId: string) {
    return this.workers.has(accountId);
  }
  private handleSyncError(accountId: string, err: ConnectorError, w: Worker) {
    this.log.warn({ accountId, code: err.code, op: err.operation }, 'sync failed');
    this.bus.emit(accountId, 'connector.error', { code: err.code, message: err.message, operation: err.operation ?? 'sync' });
    this.store.patchState(accountId, { lastError: err.code });
    switch (err.code) {
      case 'LOGIN_REQUIRED':
        this.stopWorker(accountId);
        this.setStatus(accountId, 'login_required', err.code);
        break;
      case 'CHECKPOINT_REQUIRED':
        this.stopWorker(accountId);
        this.setStatus(accountId, 'checkpoint_required', err.code);
        break;
      case 'UI_CHANGED':
      case 'RATE_LIMITED_OR_BLOCKED':
      case 'IDENTITY_MISMATCH':
        this.stopWorker(accountId);
        this.setStatus(accountId, 'degraded', err.code);
        break;
      default:
        w.backoff = Math.min((w.backoff || 5_000) * 2, 5 * 60_000);
        this.setStatus(accountId, 'degraded', err.code);
    }
  }

  // ---------- sync ----------
  syncOnce(accountId: string): Promise<void> {
    const running = this.syncing.get(accountId);
    if (running) return running;
    const p = this.doSync(accountId).finally(() => this.syncing.delete(accountId));
    this.syncing.set(accountId, p);
    return p;
  }

  private async doSync(accountId: string): Promise<void> {
    const acc = this.mustAccount(accountId);
    const adapter = this.adapterFor(acc);
    const state = this.store.getState(accountId);
    const baselineDone = state?.baselineDone ?? false;
    const emitReceived = baselineDone || this.cfg.backfillEvents;
    const sigs = this.sigs.get(accountId) ?? new Map<string, string>();
    this.sigs.set(accountId, sigs);

    const page = await adapter.listConversations(accountId, { limit: this.cfg.maxConversationsPerSync });
    for (const oc of page.items) {
      const up = this.store.upsertConversation(accountId, {
        providerId: oc.providerConversationId,
        title: oc.title,
        participants: oc.participantHandles,
        lastMessageAt: oc.latestMessageAt,
        unread: oc.unread,
      });
      const sig = JSON.stringify([oc.latestMessageAt, oc.unread, oc.title]);
      const needRead = up.created || sigs.get(oc.providerConversationId) !== sig;
      if (up.changed && baselineDone)
        this.bus.emit(accountId, 'conversation.updated', { conversationId: up.row.id, title: up.row.title, unread: up.row.unread, latestMessageAt: up.row.lastMessageAt });
      if (!needRead) continue;
      const msgs = await adapter.listMessages(accountId, oc.providerConversationId, { limit: 50 });
      this.ingest(accountId, up.row, msgs.items, emitReceived);
      sigs.set(oc.providerConversationId, sig);
    }
    this.store.patchState(accountId, { lastSyncAt: new Date().toISOString(), lastError: null, baselineDone: true });
    this.store.updateAccount(accountId, { lastAuthValidatedAt: new Date().toISOString() });
  }

  private ingest(accountId: string, conv: ConversationRow, items: ObservedMessage[], emitReceived: boolean) {
    const fps = fingerprintAll(accountId, conv.providerId ?? conv.id, items);
    items.forEach((m, i) => {
      const fp = fps[i]!;
      if (this.store.findMessageByFingerprint(accountId, fp)) return;
      if (m.direction === 'outgoing') {
        const mine = m.text ? this.store.findAdoptableOutgoing(accountId, conv.id, m.text) : undefined;
        if (mine) {
          this.store.setMessageFingerprint(accountId, mine.id, fp, m.providerMessageId ?? null);
          const ob = this.store.findUncertainOutbox(accountId, conv.id, m.text!);
          if (ob && this.store.transitionOutbox(accountId, ob.id, ['uncertain'], 'sent'))
            this.bus.emit(accountId, 'message.sent', { outboxId: ob.id, conversationId: conv.id, messageId: mine.id, resolvedFromUncertain: true });
          return;
        }
        // Uncertain outbox whose local message was never written: resolve now.
        const ob = m.text ? this.store.findUncertainOutbox(accountId, conv.id, m.text) : undefined;
        if (ob) this.store.transitionOutbox(accountId, ob.id, ['uncertain'], 'sent');
      }
      const row = this.store.insertMessageIfNew(accountId, {
        conversationId: conv.id,
        providerId: m.providerMessageId ?? null,
        fingerprint: fp,
        direction: m.direction,
        senderDisplayName: m.senderDisplayName ?? null,
        text: m.text,
        attachments: m.attachments,
        sentAt: m.sentAt,
        observedAt: new Date().toISOString(),
        deliveryStatus: m.direction === 'outgoing' ? 'sent' : 'observed',
      });
      if (row && m.direction === 'incoming' && emitReceived) this.bus.emit(accountId, 'message.received', { message: toPublicMessage(row) });
    });
  }

  // ---------- reads ----------
  getConversationOrThrow(accountId: string, conversationId: string): ConversationRow {
    const c = this.store.getConversation(accountId, conversationId);
    if (!c) throw new ConnectorError('NOT_FOUND', 'Conversation not found');
    return c;
  }

  /** Optionally pull older history from the provider into the cache for a conversation. */
  async loadOlder(accountId: string, conversationId: string): Promise<void> {
    const conv = this.getConversationOrThrow(accountId, conversationId);
    const acc = this.mustAccount(accountId);
    const msgs = await this.adapterFor(acc).listMessages(accountId, conv.providerId!, { limit: 50 });
    this.ingest(accountId, conv, msgs.items, false);
  }

  // ---------- sending ----------
  async requestSend(
    accountId: string,
    conversationId: string,
    text: string,
    idempotencyKey: string,
    dryRun: boolean,
  ): Promise<{ outbox: OutboxRow | null; replay: boolean; dryRun: boolean }> {
    const acc = this.mustAccount(accountId);
    const body = text.trim();
    if (!body) throw new ConnectorError('VALIDATION_ERROR', 'Message text must not be blank');
    if (body.length > this.cfg.maxMessageLength) throw new ConnectorError('VALIDATION_ERROR', `Message exceeds ${this.cfg.maxMessageLength} characters`);
    const conv = this.getConversationOrThrow(accountId, conversationId);
    const bodyHash = sha(`${conv.id}\n${body}`);

    const prior = this.store.findOutboxByKey(accountId, idempotencyKey);
    if (prior) {
      if (prior.bodyHash !== bodyHash) throw new ConnectorError('IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used with a different conversation or text');
      return { outbox: prior, replay: true, dryRun: false };
    }
    if (!acc.outboundEnabled) throw new ConnectorError('OUTBOUND_DISABLED', 'Outbound sending is disabled for this account (outboundEnabled=false)');
    if (acc.status !== 'connected')
      throw new ConnectorError(
        acc.status === 'login_required' ? 'LOGIN_REQUIRED' : acc.status === 'checkpoint_required' ? 'CHECKPOINT_REQUIRED' : 'ACCOUNT_NOT_CONNECTED',
        `Account is ${acc.status}`,
      );
    if (dryRun) return { outbox: null, replay: false, dryRun: true };

    const { row: ob } = this.store.createOutbox(accountId, { conversationId: conv.id, idempotencyKey, body, bodyHash, dryRun: false });

    const prev = this.sendChains.get(accountId) ?? Promise.resolve();
    const next = prev.then(() => this.executeSend(accountId, ob.id)).catch((e) => this.log.error({ accountId, err: String(e) }, 'send chain error'));
    this.sendChains.set(accountId, next);
    return { outbox: ob, replay: false, dryRun: false };
  }

  /** Resolves when the queue for the account is idle (tests). */
  async whenSendsIdle(accountId: string) {
    await this.sendChains.get(accountId);
  }

  private async executeSend(accountId: string, outboxId: string): Promise<void> {
    if (!this.store.transitionOutbox(accountId, outboxId, ['queued'], 'sending')) return;
    const ob = this.store.getOutbox(accountId, outboxId)!;
    const acc = this.mustAccount(accountId);
    const conv = this.getConversationOrThrow(accountId, ob.conversationId);
    let status: OutboxRow['status'] = 'uncertain';
    let providerMessageId: string | undefined;
    let errorCode: string | null = null;
    try {
      // Re-check just-in-time: owner may have flipped the switch or session may have dropped.
      const fresh = this.mustAccount(accountId);
      if (!fresh.outboundEnabled) throw new ConnectorError('OUTBOUND_DISABLED', 'Outbound disabled');
      const r = await this.adapterFor(acc).sendText(accountId, conv.providerId!, ob.body, ob.idempotencyKey, { title: conv.title });
      status = r.status;
      providerMessageId = r.providerMessageId;
      errorCode = r.errorCode ?? (r.status === 'uncertain' ? 'SEND_OUTCOME_UNCERTAIN' : null);
    } catch (e) {
      if (e instanceof ConnectorError) {
        // Adapter contract: throws only BEFORE any irreversible UI action => safe to mark failed.
        status = 'failed';
        errorCode = e.code;
        if (e.code === 'LOGIN_REQUIRED' || e.code === 'CHECKPOINT_REQUIRED')
          this.onAdapterStatus(accountId, e.code === 'LOGIN_REQUIRED' ? 'login_required' : 'checkpoint_required', { code: e.code });
      } else {
        status = 'uncertain'; // unknown failure: could have clicked send. Never retry.
        errorCode = 'SEND_OUTCOME_UNCERTAIN';
      }
    }
    this.store.transitionOutbox(accountId, outboxId, ['sending'], status, errorCode);
    if (status === 'sent') {
      const row = this.store.insertMessageIfNew(accountId, {
        conversationId: conv.id,
        providerId: providerMessageId ?? null,
        fingerprint: providerMessageId ? fingerprintOut(accountId, conv.providerId!, providerMessageId) : `out:${outboxId}`,
        direction: 'outgoing',
        senderDisplayName: null,
        text: ob.body,
        attachments: [],
        sentAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        deliveryStatus: 'sent',
      });
      this.bus.emit(accountId, 'message.sent', { outboxId, conversationId: conv.id, messageId: row?.id ?? null });
    } else {
      // Local record of an uncertain send so a later sync can reconcile it instead of duplicating.
      if (status === 'uncertain') {
        this.store.insertMessageIfNew(accountId, {
          conversationId: conv.id,
          providerId: null,
          fingerprint: `out:${outboxId}`,
          direction: 'outgoing',
          senderDisplayName: null,
          text: ob.body,
          attachments: [],
          sentAt: null,
          observedAt: new Date().toISOString(),
          deliveryStatus: 'uncertain',
        });
      }
      this.bus.emit(accountId, 'connector.error', { code: errorCode ?? 'TEMPORARY_FAILURE', operation: 'sendText', outboxId, outcome: status });
    }
  }

  // ---------- helpers ----------
  mustAccount(accountId: string): AccountRow {
    const a = this.store.getAccount(accountId);
    if (!a) throw new ConnectorError('NOT_FOUND', 'Account not found');
    return a;
  }
  private asConnectorError(e: unknown): ConnectorError {
    return e instanceof ConnectorError ? e : new ConnectorError('TEMPORARY_FAILURE', e instanceof Error ? e.message : 'Unknown error', { cause: e });
  }
  async waitFor(cond: () => boolean, ms = 2000) {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(10);
  }
}

function fingerprintOut(accountId: string, providerConv: string, pid: string) {
  // must equal messageFingerprint() for providerMessageId path
  return `pid:${createHash('sha256').update(`${accountId}|${providerConv}|${pid}`).digest('hex').slice(0, 40)}`;
}

export function toPublicMessage(r: MessageRow) {
  return {
    id: r.id,
    accountId: r.accountId,
    conversationId: r.conversationId,
    ...(r.providerId ? { providerMessageId: r.providerId } : {}),
    direction: r.direction,
    ...(r.senderDisplayName ? { senderDisplayName: r.senderDisplayName } : {}),
    text: r.text,
    attachments: r.attachments,
    sentAt: r.sentAt,
    observedAt: r.observedAt,
    deliveryStatus: r.deliveryStatus,
  };
}
export function toPublicConversation(r: ConversationRow) {
  return {
    id: r.id,
    accountId: r.accountId,
    ...(r.providerId ? { providerConversationId: r.providerId } : {}),
    title: r.title,
    participantHandles: r.participants,
    latestMessageAt: r.lastMessageAt,
    unread: r.unread,
  };
}
