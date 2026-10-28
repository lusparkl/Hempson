import type { BrowserContext, Page } from 'playwright';
import {
  ConnectorError,
  type AdapterCapabilities,
  type ConnectContext,
  type ConnectorStatus,
  type MessagingAdapter,
  type ObservedConversation,
  type ObservedMessage,
  type Page as ResultPage,
  type PageOpts,
  type SendOutcome,
  type SessionInfo,
  type StatusListener,
} from '@hepson/connector-core';
import { BrowserManager } from './browser-manager';
import { checkPageForChallenge, type SessionDeps } from './login';
import { deleteProfile, hasProfile, profileDir } from './profile';
import { parseConversations, parseMessages } from './parsers';
import * as sel from './selectors';
import { sendTextInPage } from './sender';
import { Mutex } from './mutex';
import { establishSession, watchForOwnerLogin } from './login';

export type BrowserAdapterOptions = {
  dataDir: string;
  baseUrl: string;
  headless: boolean;
  loginWaitMs: number;
  maxConcurrent: number;
  reconnectDelayMs?: number;
  sendConfirmMs?: number;
  reloadInboxEveryMs?: number;
};

type Sess = {
  accountId: string;
  context: BrowserContext;
  page: Page;
  status: ConnectorStatus;
  restored: boolean;
  handle: string | null;
  awaitingOwner: boolean;
  mutex: Mutex;
  expectedHandle: string | null;
  ctx: ConnectContext;
  closing: boolean;
  inboxLoadedAt: number;
  watcher?: AbortController;
};

export class BrowserInstagramAdapter implements MessagingAdapter {
  readonly kind = 'instagram-browser' as const;
  private sessions = new Map<string, Sess>();
  private statuses = new Map<string, ConnectorStatus>();
  private listeners: StatusListener[] = [];
  private mgr: BrowserManager;
  private reconnects = new Map<string, number>();

  constructor(private o: BrowserAdapterOptions) {
    this.mgr = new BrowserManager({ dataDir: o.dataDir, headless: o.headless, maxConcurrent: o.maxConcurrent });
  }

  capabilities(): AdapterCapabilities {
    return {
      kind: 'instagram-browser',
      folders: { primary: true, general: false, requests: false },
      textMessages: true,
      attachmentsRead: 'placeholder',
      olderHistoryPaging: false,
      sendText: true,
      verifiedAgainstRealProvider: false,
    };
  }
  onStatusChange(l: StatusListener) {
    this.listeners.push(l);
  }
  private emit(accountId: string, status: ConnectorStatus, detail?: { code?: string; message?: string }) {
    if (this.statuses.get(accountId) === status && !detail?.code) return;
    this.statuses.set(accountId, status);
    const s = this.sessions.get(accountId);
    if (s) s.status = status;
    for (const l of this.listeners) l(accountId, status, detail);
  }

  private deps(s: Sess): SessionDeps {
    return {
      baseUrl: this.o.baseUrl,
      loginWaitMs: this.o.loginWaitMs,
      setStatus: (st, d) => this.emit(s.accountId, st, d),
    };
  }

  async connect(accountId: string, ctx: ConnectContext): Promise<ConnectorStatus> {
    const existing = this.sessions.get(accountId);
    if (existing && !existing.closing && existing.status === 'connected') return 'connected';
    if (existing) await this.closeSession(accountId);
    const dir = profileDir(this.o.dataDir, accountId);
    const hadProfile = hasProfile(dir);
    const opened = await this.mgr.launch(accountId, () => this.onCrash(accountId));
    const s: Sess = {
      accountId,
      ...opened,
      status: 'connecting',
      restored: false,
      handle: null,
      awaitingOwner: false,
      mutex: new Mutex(),
      expectedHandle: ctx.expectedHandle,
      ctx,
      closing: false,
      inboxLoadedAt: 0,
    };
    this.sessions.set(accountId, s);
    this.statuses.set(accountId, 'connecting');
    const outcome = await establishSession(s.page, this.deps(s), { expectedHandle: ctx.expectedHandle }).catch(async (e) => {
      await this.closeSession(accountId);
      throw e;
    });
    switch (outcome.state) {
      case 'connected':
        s.handle = outcome.handle;
        s.restored = hadProfile;
        ctx.onHandleObserved?.(outcome.handle);
        this.reconnects.delete(accountId);
        this.emit(accountId, 'connected');
        return 'connected';
      case 'login_required':
      case 'checkpoint_required':
        if (!ctx.interactiveLogin) {
          await this.closeSession(accountId, { keepStatus: true });
          this.emit(accountId, outcome.state, { code: outcome.state === 'login_required' ? 'LOGIN_REQUIRED' : 'CHECKPOINT_REQUIRED' });
          return outcome.state;
        }
        s.awaitingOwner = true;
        this.emit(accountId, outcome.state, { code: outcome.state === 'login_required' ? 'LOGIN_REQUIRED' : 'CHECKPOINT_REQUIRED' });
        s.watcher = new AbortController();
        void watchForOwnerLogin(s.page, this.deps(s), { expectedHandle: ctx.expectedHandle, signal: s.watcher.signal })
          .then(async (r) => {
            s.awaitingOwner = false;
            if (s.closing) return;
            if (r.state === 'connected') {
              s.handle = r.handle;
              s.restored = false; // owner logged in during this session
              ctx.onHandleObserved?.(r.handle);
              this.emit(accountId, 'connected');
            } else if (r.state === 'aborted') {
              return;
            } else {
              await this.closeSession(accountId, { keepStatus: true });
              if (r.state === 'identity_mismatch') this.emit(accountId, 'failed', { code: 'IDENTITY_MISMATCH' });
              else if (r.state === 'checkpoint_required') this.emit(accountId, 'checkpoint_required', { code: 'CHECKPOINT_REQUIRED' });
              else this.emit(accountId, 'login_required', { code: 'LOGIN_REQUIRED' });
            }
          })
          .catch(() => undefined);
        return outcome.state;
    }
  }

  private async onCrash(accountId: string) {
    const s = this.sessions.get(accountId);
    if (!s || s.closing) return;
    this.sessions.delete(accountId);
    this.emit(accountId, 'degraded', { code: 'TEMPORARY_FAILURE', message: 'Browser closed unexpectedly' });
    const n = (this.reconnects.get(accountId) ?? 0) + 1;
    this.reconnects.set(accountId, n);
    if (n > 3) {
      this.emit(accountId, 'failed', { code: 'TEMPORARY_FAILURE' });
      return;
    }
    await new Promise((r) => setTimeout(r, (this.o.reconnectDelayMs ?? 5_000) * n));
    if (this.sessions.has(accountId) || this.statuses.get(accountId) !== 'degraded') return;
    // profile is untouched; reopen non-interactively with the same stored login
    await this.connect(accountId, { ...s.ctx, interactiveLogin: false }).catch(() => this.emit(accountId, 'failed', { code: 'TEMPORARY_FAILURE' }));
  }

  async getStatus(accountId: string) {
    return this.statuses.get(accountId) ?? 'disconnected';
  }

  private live(accountId: string): Sess {
    const s = this.sessions.get(accountId);
    if (!s || s.closing) throw new ConnectorError('ACCOUNT_NOT_CONNECTED', 'Browser session is not running');
    if (s.status === 'login_required') throw new ConnectorError('LOGIN_REQUIRED', 'Owner login required');
    if (s.status === 'checkpoint_required') throw new ConnectorError('CHECKPOINT_REQUIRED', 'Instagram security check pending');
    if (s.status !== 'connected' && s.status !== 'degraded') throw new ConnectorError('ACCOUNT_NOT_CONNECTED', `Session is ${s.status}`);
    return s;
  }

  /** After any navigation: stop and surface login/challenge instead of acting on a wrong page. */
  private async guard(s: Sess, op: string) {
    try {
      await checkPageForChallenge(s.page, this.o.baseUrl);
    } catch (e) {
      if (e instanceof ConnectorError && (e.code === 'LOGIN_REQUIRED' || e.code === 'CHECKPOINT_REQUIRED')) {
        this.emit(s.accountId, e.code === 'LOGIN_REQUIRED' ? 'login_required' : 'checkpoint_required', { code: e.code });
      }
      throw e;
    }
    void op;
  }

  private async gotoInbox(s: Sess) {
    // The inbox SPA updates itself, so we don't reload every poll; but a periodic reload is the only
    // way to notice a revoked login / challenge that the stale DOM would hide.
    const stale = Date.now() - s.inboxLoadedAt >= (this.o.reloadInboxEveryMs ?? 5 * 60_000);
    if (stale || !new URL(s.page.url()).pathname.startsWith('/direct/inbox')) {
      s.inboxLoadedAt = Date.now();
      await s.page.goto(`${this.o.baseUrl}/direct/inbox/`, { waitUntil: 'domcontentloaded' }).catch((e) => {
        throw new ConnectorError('TEMPORARY_FAILURE', `Navigation failed: ${(e as Error).message.split('\n')[0]}`);
      });
    }
    await this.guard(s, 'inbox');
    if (!(await sel.inboxReady(s.page))) throw new ConnectorError('UI_CHANGED', 'Inbox region not found', { operation: 'listConversations' });
  }

  async listConversations(accountId: string, opts: PageOpts = {}): Promise<ResultPage<ObservedConversation>> {
    const s = this.live(accountId);
    return s.mutex.run(async () => {
      await this.gotoInbox(s);
      const rows = await sel.extractConversationRows(s.page);
      const items = parseConversations(rows).slice(0, opts.limit ?? 50);
      return { items, nextCursor: null };
    });
  }

  private async openThread(s: Sess, providerConversationId: string, expectedTitle?: string, op = 'listMessages') {
    await s.page.goto(`${this.o.baseUrl}/direct/t/${encodeURIComponent(providerConversationId)}/`, { waitUntil: 'domcontentloaded' }).catch((e) => {
      throw new ConnectorError('TEMPORARY_FAILURE', `Navigation failed: ${(e as Error).message.split('\n')[0]}`);
    });
    await this.guard(s, op);
    const url = new URL(s.page.url());
    if (!url.pathname.includes(`/direct/t/${providerConversationId}`)) throw new ConnectorError('UI_CHANGED', 'Opened a different conversation than requested', { operation: op });
    const title = await sel.readThreadTitle(s.page);
    if (expectedTitle !== undefined) {
      const { normalizeTitle } = await import('./parsers');
      if (!title || normalizeTitle(title) !== normalizeTitle(expectedTitle))
        throw new ConnectorError('UI_CHANGED', 'Conversation title does not match the expected chat; refusing to continue', { operation: op });
    }
  }

  async listMessages(accountId: string, providerConversationId: string, opts: PageOpts = {}): Promise<ResultPage<ObservedMessage>> {
    const s = this.live(accountId);
    return s.mutex.run(async () => {
      await this.openThread(s, providerConversationId);
      const rows = await sel.extractMessageRows(s.page);
      const items = parseMessages(rows);
      const limit = opts.limit ?? 50;
      return { items: items.slice(-limit), nextCursor: null }; // only loaded DOM history; no scrolling
    });
  }

  async sendText(accountId: string, providerConversationId: string, text: string, _key: string, expected?: { title: string }): Promise<SendOutcome> {
    const s = this.live(accountId);
    return s.mutex.run(async () => {
      await this.openThread(s, providerConversationId, expected?.title, 'sendText');
      return sendTextInPage(s.page, text, { confirmMs: this.o.sendConfirmMs });
    });
  }

  sessionInfo(accountId: string): SessionInfo {
    const s = this.sessions.get(accountId);
    return {
      restoredFromSavedLogin: !!s && s.status === 'connected' && s.restored,
      hasSavedLogin: hasProfile(profileDir(this.o.dataDir, accountId)),
      observedHandle: s?.handle ?? null,
      awaitingOwner: !!s?.awaitingOwner,
    };
  }

  private async closeSession(accountId: string, _o: { keepStatus?: boolean } = {}) {
    const s = this.sessions.get(accountId);
    if (!s) return;
    s.closing = true;
    s.watcher?.abort();
    this.sessions.delete(accountId);
    await this.mgr.close(accountId, s.context);
  }

  async disconnect(accountId: string) {
    await this.closeSession(accountId);
    this.statuses.set(accountId, 'disconnected');
  }
  async forgetSession(accountId: string) {
    await this.closeSession(accountId);
    deleteProfile(this.o.dataDir, accountId);
    this.statuses.set(accountId, 'login_required');
  }
  async shutdown() {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }
}
