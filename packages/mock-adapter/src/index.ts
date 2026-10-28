import { randomUUID } from 'node:crypto';
import {
  ConnectorError,
  type AdapterCapabilities,
  type ConnectContext,
  type ConnectorStatus,
  type MessagingAdapter,
  type ObservedConversation,
  type ObservedMessage,
  type Page,
  type PageOpts,
  type SendOutcome,
  type StatusListener,
} from '@hepson/connector-core';

type MockThread = { conv: ObservedConversation; messages: ObservedMessage[] };
type MockAccount = { status: ConnectorStatus; threads: Map<string, MockThread>; sentLog: Array<{ key: string; providerConversationId: string; text: string }> };

const SEED: Array<{ id: string; title: string; handle: string; msgs: Array<['incoming' | 'outgoing', string | null, string, ObservedMessage['attachments']?]> }> = [
  {
    id: 'mock-thread-olena',
    title: 'Олена Коваль',
    handle: 'olena.koval',
    msgs: [
      ['incoming', 'Доброго дня! Чи є сукня з другого допису у розмірі M?', '2026-10-20T09:00:00.000Z'],
      ['outgoing', 'Вітаю! Так, M є в наявності. Колір чорний.', '2026-10-20T09:05:00.000Z'],
      ['incoming', 'Чудово, а доставка Новою поштою у Львів скільки днів?', '2026-10-20T09:06:00.000Z'],
    ],
  },
  {
    id: 'mock-thread-andrii',
    title: 'Андрій Мельник',
    handle: 'andrii_m',
    msgs: [
      ['incoming', null, '2026-10-21T14:00:00.000Z', [{ kind: 'image', metadata: { note: 'unsupported_media_placeholder' } }]],
      ['incoming', 'Це фото кросівок які я купив, розмір замалий. Можна обмін?', '2026-10-21T14:01:00.000Z'],
    ],
  },
  {
    id: 'mock-thread-iryna',
    title: 'iryna.style',
    handle: 'iryna.style',
    msgs: [['incoming', 'Скільки коштує шкіряний ремінь?', '2026-10-22T18:30:00.000Z']],
  },
];

/**
 * Deterministic in-memory provider. Same adapter contract as the real ones.
 * Dev-only fixture controls are prefixed `dev*` and exposed by the API only under /v1/dev (mock accounts).
 */
export class MockAdapter implements MessagingAdapter {
  readonly kind = 'mock' as const;
  private accounts = new Map<string, MockAccount>();
  private listeners: StatusListener[] = [];
  /** Next send results (FIFO). Default: 'sent'. */
  private sendPlan: Array<'sent' | 'failed' | 'uncertain' | 'throw_ui_changed'> = [];
  sendCalls = 0;

  capabilities(): AdapterCapabilities {
    return {
      kind: 'mock',
      folders: { primary: true, general: false, requests: false },
      textMessages: true,
      attachmentsRead: 'placeholder',
      olderHistoryPaging: true,
      sendText: true,
      verifiedAgainstRealProvider: false,
    };
  }
  onStatusChange(l: StatusListener) {
    this.listeners.push(l);
  }
  private set(accountId: string, status: ConnectorStatus, detail?: { code?: string; message?: string }) {
    const a = this.acc(accountId);
    a.status = status;
    for (const l of this.listeners) l(accountId, status, detail);
  }
  private acc(accountId: string): MockAccount {
    let a = this.accounts.get(accountId);
    if (!a) {
      const threads = new Map<string, MockThread>();
      for (const s of SEED) {
        const messages: ObservedMessage[] = s.msgs.map(([direction, text, sentAt, attachments], ordinal) => ({
          providerMessageId: `${s.id}-m${ordinal + 1}`,
          direction,
          senderDisplayName: direction === 'incoming' ? s.title : 'shop',
          text,
          attachments: attachments ?? [],
          sentAt,
          ordinal,
        }));
        threads.set(s.id, {
          conv: { providerConversationId: s.id, title: s.title, participantHandles: [s.handle], latestMessageAt: messages.at(-1)!.sentAt, unread: false },
          messages,
        });
      }
      a = { status: 'disconnected', threads, sentLog: [] };
      this.accounts.set(accountId, a);
    }
    return a;
  }

  async connect(accountId: string, _ctx: ConnectContext): Promise<ConnectorStatus> {
    this.acc(accountId);
    this.set(accountId, 'connected');
    return 'connected';
  }
  async getStatus(accountId: string) {
    return this.acc(accountId).status;
  }
  private requireConnected(accountId: string) {
    const s = this.acc(accountId).status;
    if (s === 'login_required') throw new ConnectorError('LOGIN_REQUIRED', 'Mock session logged out');
    if (s === 'checkpoint_required') throw new ConnectorError('CHECKPOINT_REQUIRED', 'Mock checkpoint');
    if (s !== 'connected' && s !== 'degraded') throw new ConnectorError('ACCOUNT_NOT_CONNECTED', `Mock account is ${s}`);
  }
  async listConversations(accountId: string, opts: PageOpts = {}): Promise<Page<ObservedConversation>> {
    this.requireConnected(accountId);
    const all = [...this.acc(accountId).threads.values()].map((t) => ({ ...t.conv })).sort((a, b) => (b.latestMessageAt ?? '').localeCompare(a.latestMessageAt ?? ''));
    return { items: all.slice(0, opts.limit ?? 50), nextCursor: null };
  }
  async listMessages(accountId: string, id: string, opts: PageOpts = {}): Promise<Page<ObservedMessage>> {
    this.requireConnected(accountId);
    const t = this.acc(accountId).threads.get(id);
    if (!t) throw new ConnectorError('NOT_FOUND', 'Mock thread not found');
    const end = opts.cursor ? Number(opts.cursor) : t.messages.length;
    const limit = opts.limit ?? 50;
    const start = Math.max(0, end - limit);
    return { items: t.messages.slice(start, end).map((m) => ({ ...m, ordinal: m.ordinal - start })), nextCursor: start > 0 ? String(start) : null };
  }
  async sendText(accountId: string, id: string, text: string, key: string, expected?: { title: string }): Promise<SendOutcome> {
    this.requireConnected(accountId);
    this.sendCalls++;
    const t = this.acc(accountId).threads.get(id);
    if (!t) throw new ConnectorError('NOT_FOUND', 'Mock thread not found');
    if (expected && expected.title !== t.conv.title) throw new ConnectorError('UI_CHANGED', 'Thread title mismatch; refusing to send', { operation: 'sendText' });
    const plan = this.sendPlan.shift() ?? 'sent';
    if (plan === 'throw_ui_changed') throw new ConnectorError('UI_CHANGED', 'Composer not found', { operation: 'sendText' });
    if (plan === 'failed') return { status: 'failed', errorCode: 'TEMPORARY_FAILURE' };
    if (plan === 'uncertain') return { status: 'uncertain' };
    const a = this.acc(accountId);
    a.sentLog.push({ key, providerConversationId: id, text });
    const m: ObservedMessage = {
      providerMessageId: `mock-out-${randomUUID()}`,
      direction: 'outgoing',
      senderDisplayName: 'shop',
      text,
      attachments: [],
      sentAt: new Date().toISOString(),
      ordinal: t.messages.length,
    };
    t.messages.push(m);
    t.conv.latestMessageAt = m.sentAt;
    return { status: 'sent', providerMessageId: m.providerMessageId };
  }
  sessionInfo(accountId: string) {
    const a = this.acc(accountId);
    return { restoredFromSavedLogin: false, hasSavedLogin: a.status === 'connected', observedHandle: null, awaitingOwner: false };
  }
  async disconnect(accountId: string) {
    this.set(accountId, 'disconnected');
  }
  async forgetSession(accountId: string) {
    this.set(accountId, 'login_required');
  }
  async shutdown() {
    for (const id of this.accounts.keys()) this.acc(id).status = 'disconnected';
  }

  // ---- dev fixture controls ----
  devInjectIncoming(accountId: string, providerConversationId: string, text: string | null, opts: { attachments?: ObservedMessage['attachments']; sentAt?: string } = {}) {
    const t = this.acc(accountId).threads.get(providerConversationId);
    if (!t) throw new ConnectorError('NOT_FOUND', 'Mock thread not found');
    const m: ObservedMessage = {
      providerMessageId: `mock-in-${randomUUID()}`,
      direction: 'incoming',
      senderDisplayName: t.conv.title,
      text,
      attachments: opts.attachments ?? [],
      sentAt: opts.sentAt ?? new Date().toISOString(),
      ordinal: t.messages.length,
    };
    t.messages.push(m);
    t.conv.latestMessageAt = m.sentAt;
    t.conv.unread = true;
    return m;
  }
  /** Re-add an already-seen message (same provider id) to prove dedupe. */
  devDuplicateLast(accountId: string, providerConversationId: string) {
    const t = this.acc(accountId).threads.get(providerConversationId)!;
    const last = t.messages.at(-1)!;
    t.messages.push({ ...last, ordinal: t.messages.length });
  }
  devSetStatus(accountId: string, status: ConnectorStatus) {
    this.set(accountId, status, status === 'login_required' ? { code: 'LOGIN_REQUIRED' } : status === 'checkpoint_required' ? { code: 'CHECKPOINT_REQUIRED' } : undefined);
  }
  devPlanSends(...p: typeof this.sendPlan) {
    this.sendPlan.push(...p);
  }
  devSentLog(accountId: string) {
    return this.acc(accountId).sentLog;
  }
}
