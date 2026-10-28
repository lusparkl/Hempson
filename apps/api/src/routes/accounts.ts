import type { FastifyInstance } from 'fastify';
import { ConnectorError } from '@hepson/connector-core';
import type { AccountRow } from '@hepson/database';
import type { ConnectorService } from '../services/connector-service';
import { toPublicConversation, toPublicMessage } from '../services/connector-service';
import { toPublicEvent } from '../services/event-bus';
import type { ProfileAdmin } from '../services/profile-admin';
import { route } from './define';
import * as S from './schemas';

const HUMAN: Record<string, string> = {
  disconnected: 'Not running. Saved login (if any) is kept; press Reconnect to resume.',
  login_required: 'Re-login required: the owner must sign in to Instagram in the visible browser window.',
  connecting: 'Connecting…',
  connected: 'Connected.',
  degraded: 'Connected with problems (see lastErrorCode). Worker may be paused until fixed.',
  checkpoint_required: 'Instagram security check: the owner must complete it manually in the visible browser window.',
  failed: 'Failed. See lastErrorCode and events.',
};

export function accountView(svc: ConnectorService, a: AccountRow, profiles: ProfileAdmin) {
  const adapter = svc.adapterFor(a);
  const info = adapter.sessionInfo(a.id);
  return {
    accountId: a.id,
    label: a.label,
    connectorType: a.connectorType,
    dataSource: a.connectorType === 'mock' ? 'MOCK (simulated data)' : 'REAL (Instagram via experimental browser adapter)',
    status: a.status,
    statusMessage: HUMAN[a.status] ?? a.status,
    enabled: a.enabled,
    paused: a.paused,
    outboundEnabled: a.outboundEnabled,
    consentRecordedAt: a.consentRecordedAt,
    expectedInstagramHandle: a.expectedInstagramHandle,
    lastAuthValidatedAt: a.lastAuthValidatedAt,
    lastErrorCode: a.lastErrorCode,
    restoredFromSavedLogin: info.restoredFromSavedLogin,
    hasSavedLogin: info.hasSavedLogin || profiles.hasProfile(a),
    awaitingOwnerAction: info.awaitingOwner,
    workerRunning: svc.isWorkerRunning(a.id),
    lastSyncAt: svc.store.getState(a.id)?.lastSyncAt ?? null,
    capabilities: adapter.capabilities(),
  };
}

export function registerAccountRoutes(
  app: FastifyInstance,
  svc: ConnectorService,
  profiles: ProfileAdmin,
  opts: { retentionDays: number; enableDev: boolean; maxMessageLength: number },
) {
  const store = svc.store;
  const view = (a: AccountRow) => accountView(svc, a, profiles);
  const own = (id: string) => svc.mustAccount(id);

  route(app, {
    method: 'GET',
    url: '/v1/accounts',
    summary: 'List accounts visible to this key',
    tag: 'accounts',
    auth: 'any',
    handler: ({ principal }) => ({ items: store.listAccounts(principal?.accountId ?? undefined).map(view) }),
  });
  route(app, {
    method: 'POST',
    url: '/v1/accounts',
    summary: 'Create a store account (admin). Real accounts require consentConfirmed=true',
    tag: 'accounts',
    auth: 'admin',
    status: 201,
    body: S.CreateAccountBody,
    handler: ({ body }) => {
      if (!body.consentConfirmed && body.connectorType !== 'mock')
        throw new ConnectorError('CONSENT_REQUIRED', "consentConfirmed must be true: record the shop owner's express authorization first");
      const a = store.createAccount({
        label: body.label,
        connectorType: body.connectorType,
        consentRecordedAt: body.consentConfirmed ? new Date().toISOString() : null,
        expectedInstagramHandle: body.expectedInstagramHandle?.toLowerCase() ?? null,
      });
      return view(a);
    },
  });
  route(app, {
    method: 'GET',
    url: '/v1/accounts/:accountId/status',
    summary: 'Connection status',
    tag: 'session',
    auth: 'account',
    params: S.AccountIdParams,
    handler: ({ params }) => view(own(params.accountId)),
  });
  route(app, {
    method: 'POST',
    url: '/v1/accounts/:accountId/session/start',
    summary: 'Start session (opens visible browser for owner login if needed)',
    tag: 'session',
    auth: 'account',
    params: S.AccountIdParams,
    body: S.SessionStartBody,
    status: 202,
    handler: async ({ params, body }) => {
      await svc.startSession(params.accountId, { interactive: body.interactive });
      return view(own(params.accountId));
    },
  });
  route(app, {
    method: 'POST',
    url: '/v1/accounts/:accountId/session/pause',
    summary: 'Pause worker; keeps saved login',
    tag: 'session',
    auth: 'account',
    params: S.AccountIdParams,
    handler: async ({ params }) => {
      await svc.pause(params.accountId);
      return view(own(params.accountId));
    },
  });
  route(app, {
    method: 'POST',
    url: '/v1/accounts/:accountId/session/resume',
    summary: 'Resume using the saved login (no owner action if still valid)',
    tag: 'session',
    auth: 'account',
    params: S.AccountIdParams,
    status: 202,
    handler: async ({ params }) => {
      await svc.resume(params.accountId);
      return view(own(params.accountId));
    },
  });
  route(app, {
    method: 'POST',
    url: '/v1/accounts/:accountId/session/disconnect',
    summary: 'Stop worker; keeps saved login',
    tag: 'session',
    auth: 'account',
    params: S.AccountIdParams,
    handler: async ({ params }) => {
      await svc.disconnect(params.accountId);
      return view(own(params.accountId));
    },
  });
  route(app, {
    method: 'DELETE',
    url: '/v1/accounts/:accountId/session/profile',
    summary: 'FORGET saved login: deletes the stored browser profile. Body must repeat the account label',
    tag: 'session',
    auth: 'account',
    params: S.AccountIdParams,
    body: S.ForgetBody,
    handler: async ({ params, body }) => {
      if (body.confirmLabel !== own(params.accountId).label) throw new ConnectorError('CONFIRMATION_REQUIRED', 'confirmLabel must equal the account label');
      await svc.forgetSession(params.accountId);
      return view(own(params.accountId));
    },
  });
  route(app, {
    method: 'PATCH',
    url: '/v1/accounts/:accountId/settings',
    summary: 'Enable/disable outbound sending',
    tag: 'accounts',
    auth: 'account',
    params: S.AccountIdParams,
    body: S.SettingsBody,
    handler: ({ params, body }) => {
      own(params.accountId);
      store.updateAccount(params.accountId, { outboundEnabled: body.outboundEnabled });
      return view(own(params.accountId));
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/accounts/:accountId/conversations',
    summary: 'List cached conversations (newest first)',
    tag: 'messaging',
    auth: 'account',
    params: S.AccountIdParams,
    query: S.PageQuery,
    handler: ({ params, query }) => {
      own(params.accountId);
      const r = store.listConversations(params.accountId, query.limit, query.cursor);
      return { items: r.items.map(toPublicConversation), nextCursor: r.nextCursor };
    },
  });
  route(app, {
    method: 'GET',
    url: '/v1/accounts/:accountId/conversations/:conversationId/messages',
    summary: 'List messages (oldest-first within page; cursor pages to older)',
    tag: 'messaging',
    auth: 'account',
    params: S.ConversationParams,
    query: S.PageQuery,
    handler: ({ params, query }) => {
      svc.getConversationOrThrow(params.accountId, params.conversationId);
      const r = store.listMessages(params.accountId, params.conversationId, query.limit, query.cursor);
      return { items: r.items.map(toPublicMessage), nextCursor: r.nextCursor };
    },
  });
  route(app, {
    method: 'POST',
    url: '/v1/accounts/:accountId/conversations/:conversationId/messages',
    summary: 'Send ONE text reply in an existing conversation (async; 202)',
    tag: 'messaging',
    auth: 'account',
    params: S.ConversationParams,
    body: S.SendBody,
    status: 202,
    handler: async ({ params, body, reply }) => {
      own(params.accountId);
      const r = await svc.requestSend(params.accountId, params.conversationId, body.text, body.idempotencyKey, body.dryRun ?? false);
      if (r.dryRun) {
        reply.status(200);
        return { dryRun: true, ok: true };
      }
      if (r.replay) reply.header('Idempotent-Replay', 'true');
      return outboxView(r.outbox!);
    },
  });
  route(app, {
    method: 'GET',
    url: '/v1/accounts/:accountId/outbox',
    summary: 'Recent outbox entries',
    tag: 'messaging',
    auth: 'account',
    params: S.AccountIdParams,
    handler: ({ params }) => {
      own(params.accountId);
      return { items: store.listOutbox(params.accountId).map(outboxView) };
    },
  });
  route(app, {
    method: 'GET',
    url: '/v1/accounts/:accountId/outbox/:outboxId',
    summary: 'Send outcome',
    tag: 'messaging',
    auth: 'account',
    params: S.OutboxParams,
    handler: ({ params }) => {
      const ob = store.getOutbox(params.accountId, params.outboxId);
      if (!ob) throw new ConnectorError('NOT_FOUND', 'Outbox entry not found');
      return outboxView(ob);
    },
  });
  route(app, {
    method: 'POST',
    url: '/v1/accounts/:accountId/outbox/:outboxId/review',
    summary: 'Mark an uncertain send as reviewed by a human (never auto-retried)',
    tag: 'messaging',
    auth: 'account',
    params: S.OutboxParams,
    handler: ({ params }) => {
      const ob = store.getOutbox(params.accountId, params.outboxId);
      if (!ob) throw new ConnectorError('NOT_FOUND', 'Outbox entry not found');
      store.markOutboxReviewed(params.accountId, ob.id);
      return outboxView(store.getOutbox(params.accountId, ob.id)!);
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/accounts/:accountId/events',
    summary: 'Replay events with sequence > afterSequence',
    tag: 'events',
    auth: 'account',
    params: S.AccountIdParams,
    query: S.EventsQuery,
    handler: ({ params, query }) => {
      own(params.accountId);
      const rows = store.listEvents(params.accountId, query.afterSequence, query.limit);
      return { items: rows.map(toPublicEvent), lastSequence: rows.at(-1)?.sequence ?? query.afterSequence };
    },
  });
  app.get('/v1/accounts/:accountId/events/stream', async (req, reply) => {
    const principal = req.principal;
    const { accountId } = S.AccountIdParams.parse(req.params);
    if (!principal) throw new ConnectorError('UNAUTHORIZED', 'Missing or invalid API key');
    if (principal.accountId !== null && principal.accountId !== accountId) throw new ConnectorError('FORBIDDEN', 'API key is not valid for this account');
    own(accountId);
    const q = req.query as { afterSequence?: string };
    let last = Number(q.afterSequence ?? req.headers['last-event-id'] ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (ev: ReturnType<typeof toPublicEvent>) => {
      if (ev.sequence <= last) return;
      last = ev.sequence;
      res.write(`id: ${ev.sequence}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    // subscribe first (buffer), then replay, so nothing is lost between the two
    const buffer: Array<ReturnType<typeof toPublicEvent>> = [];
    let replaying = true;
    const unsub = svc.bus.subscribe(accountId, (e) => (replaying ? buffer.push(e) : write(e)));
    for (;;) {
      const rows = store.listEvents(accountId, last, 500);
      rows.forEach((r) => write(toPublicEvent(r)));
      if (rows.length < 500) break;
    }
    buffer.sort((a, b) => a.sequence - b.sequence).forEach(write);
    replaying = false;
    res.write(': connected\n\n');
    const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(hb);
      unsub();
    });
  });

  route(app, {
    method: 'GET',
    url: '/v1/accounts/:accountId/export',
    summary: 'Export cached conversations, messages, outbox (never auth/profile data)',
    tag: 'privacy',
    auth: 'account',
    params: S.AccountIdParams,
    handler: ({ params }) => {
      own(params.accountId);
      return store.exportAccountData(params.accountId);
    },
  });
  route(app, {
    method: 'DELETE',
    url: '/v1/accounts/:accountId/data',
    summary: 'Delete cached conversations/messages/outbox (keeps saved login). Body repeats label',
    tag: 'privacy',
    auth: 'account',
    params: S.AccountIdParams,
    body: S.DeleteDataBody,
    handler: ({ params, body }) => {
      if (body.confirmLabel !== own(params.accountId).label) throw new ConnectorError('CONFIRMATION_REQUIRED', 'confirmLabel must equal the account label');
      store.deleteAccountData(params.accountId);
      return { deleted: true };
    },
  });
  route(app, {
    method: 'POST',
    url: '/v1/accounts/:accountId/retention/purge',
    summary: `Apply retention policy now (default ${opts.retentionDays} days)`,
    tag: 'privacy',
    auth: 'account',
    params: S.AccountIdParams,
    handler: ({ params }) => {
      own(params.accountId);
      return store.purgeOlderThan(params.accountId, opts.retentionDays);
    },
  });
  route(app, {
    method: 'POST',
    url: '/v1/accounts/:accountId/api-keys',
    summary: 'Create an account-scoped API key (admin). Shown once',
    tag: 'auth',
    auth: 'admin',
    params: S.AccountIdParams,
    body: S.CreateKeyBody,
    status: 201,
    handler: ({ params, body }) => {
      own(params.accountId);
      const { key, row } = store.createApiKey(body.name, params.accountId);
      return { id: row.id, accountId: params.accountId, key };
    },
  });

  if (opts.enableDev) registerDevRoutes(app, svc);
}

export function outboxView(o: {
  id: string;
  accountId: string;
  conversationId: string;
  status: string;
  errorCode: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  body: string;
}) {
  return {
    outboxId: o.id,
    accountId: o.accountId,
    conversationId: o.conversationId,
    status: o.status,
    errorCode: o.errorCode,
    needsReview: o.status === 'uncertain' && !o.reviewedAt,
    reviewedAt: o.reviewedAt,
    body: o.body,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

import { MockAdapter } from '@hepson/mock-adapter';
function registerDevRoutes(app: FastifyInstance, svc: ConnectorService) {
  const mockOf = (accountId: string) => {
    const a = svc.mustAccount(accountId);
    const ad = svc.adapterFor(a);
    if (a.connectorType !== 'mock' || !(ad instanceof MockAdapter)) throw new ConnectorError('FORBIDDEN', 'Dev fixture actions work on mock accounts only');
    return ad;
  };
  route(app, {
    method: 'POST',
    url: '/v1/dev/accounts/:accountId/inject-incoming',
    summary: 'DEV/MOCK ONLY: simulate an incoming customer message',
    tag: 'dev',
    auth: 'account',
    params: S.AccountIdParams,
    body: S.DevInjectBody,
    handler: async ({ params, body }) => {
      const ad = mockOf(params.accountId);
      ad.devInjectIncoming(
        params.accountId,
        body.providerConversationId,
        body.imageOnly ? null : body.text,
        body.imageOnly ? { attachments: [{ kind: 'image', metadata: { note: 'unsupported_media_placeholder' } }] } : {},
      );
      await svc.syncOnce(params.accountId);
      return { ok: true };
    },
  });
  route(app, {
    method: 'POST',
    url: '/v1/dev/accounts/:accountId/set-status',
    summary: 'DEV/MOCK ONLY: simulate logout / checkpoint',
    tag: 'dev',
    auth: 'account',
    params: S.AccountIdParams,
    body: S.DevStatusBody,
    handler: ({ params, body }) => {
      mockOf(params.accountId).devSetStatus(params.accountId, body.status);
      return { ok: true };
    },
  });
  route(app, {
    method: 'POST',
    url: '/v1/dev/accounts/:accountId/plan-sends',
    summary: 'DEV/MOCK ONLY: script the next send outcomes',
    tag: 'dev',
    auth: 'account',
    params: S.AccountIdParams,
    body: S.DevPlanBody,
    handler: ({ params, body }) => {
      mockOf(params.accountId).devPlanSends(...body.outcomes);
      return { ok: true };
    },
  });
  route(app, {
    method: 'POST',
    url: '/v1/dev/accounts/:accountId/sync',
    summary: 'DEV: run one sync now',
    tag: 'dev',
    auth: 'account',
    params: S.AccountIdParams,
    handler: async ({ params }) => {
      svc.mustAccount(params.accountId);
      await svc.syncOnce(params.accountId);
      return { ok: true };
    },
  });
}
