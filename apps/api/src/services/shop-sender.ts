import { randomUUID } from 'node:crypto';
import { ConnectorError } from '@hepson/connector-core';
import { INSTAGRAM_CHANNEL, WEB_CHANNEL, type ConversationRepository, type ShopMessageRow, type Store } from '@hepson/database';
import { channelOf } from './channel-bridge';
import type { ConnectorService } from './connector-service';
import type { InstagramService } from './instagram';

/** How a reply leaves Hepson: through a connector account, the official Instagram API, or (website chat) by being stored where the visitor reads it. */
export type Delivery = { kind: 'connector'; accountId: string; providerConversationId: string } | { kind: 'instagram' } | { kind: 'internal' };

export type SendOutcome = { status: 'sent' | 'uncertain' | 'failed'; code: string | null; message: ShopMessageRow };

/**
 * Sends the text of an already recorded `pending` shop-side message through the connector and reconciles the row.
 * `requestSend` throws only before anything is queued, so a throw means nothing was sent (row marked `failed`, error
 * rethrown for `rethrow`, else reported as a failed outcome). `uncertain` is never retried (connector rule).
 */
export async function deliverPending(
  d: { store: Store; svc: ConnectorService; conversations: ConversationRepository; ig?: InstagramService },
  t: { shopId: string; message: ShopMessageRow; idempotencyKey: string } & Delivery,
  opts: { rethrow?: boolean } = {},
): Promise<SendOutcome> {
  const { store, svc, conversations } = d;
  if (t.kind === 'internal') {
    // Nothing external to acknowledge: the row is the message. The generated id marks it as ours, not a platform ack.
    const message = conversations.setDeliveryStatus(t.shopId, t.message.id, 'sent', { externalId: `web:${randomUUID()}` });
    return { status: 'sent', code: null, message };
  }
  if (t.kind === 'instagram') return deliverInstagram(d, t, opts);
  const fail = (code: string) => {
    const message = conversations.setDeliveryStatus(t.shopId, t.message.id, 'failed', { error: code });
    return { status: 'failed' as const, code, message };
  };
  let outboxId: string | undefined;
  try {
    outboxId = (await svc.requestSend(t.accountId, t.providerConversationId, t.message.text ?? '', t.idempotencyKey, false)).outbox?.id;
  } catch (e) {
    const out = fail(e instanceof ConnectorError ? e.code : 'SEND_REJECTED');
    if (opts.rethrow) throw e;
    return out;
  }
  await svc.whenSendsIdle(t.accountId);
  const ob = outboxId ? store.getOutbox(t.accountId, outboxId) : undefined;
  const row = conversations.getMessage(t.shopId, t.message.id)!;
  if (ob?.status === 'sent') return { status: 'sent', code: row.deliveryStatus === 'sent' ? null : 'MIRROR_PENDING', message: row };
  if (ob?.status === 'uncertain') return { status: 'uncertain', code: ob.errorCode, message: row };
  if (row.deliveryStatus === 'pending') return fail(ob?.errorCode ?? 'SEND_FAILED');
  return { status: 'failed', code: ob?.errorCode ?? 'SEND_FAILED', message: row };
}

/**
 * One attempt through the official Instagram API. The 24-hour window and connection are checked before anything is
 * sent (`OUTSIDE_MESSAGING_WINDOW`); `uncertain` is final. An echo webhook may have adopted the row first: then it is already `sent`.
 */
async function deliverInstagram(
  d: { conversations: ConversationRepository; ig?: InstagramService },
  t: { shopId: string; message: ShopMessageRow },
  opts: { rethrow?: boolean },
): Promise<SendOutcome> {
  const { conversations, ig } = d;
  const settle = (status: 'sent' | 'uncertain' | 'failed', code: string | null, externalId?: string): SendOutcome => {
    const cur = conversations.getMessage(t.shopId, t.message.id)!;
    if (cur.deliveryStatus !== 'pending' && !(cur.deliveryStatus === 'uncertain' && status === 'sent')) return { status: cur.deliveryStatus === 'sent' ? 'sent' : status, code, message: cur };
    const message = conversations.setDeliveryStatus(t.shopId, t.message.id, status, { externalId, error: code ?? undefined });
    return { status, code, message };
  };
  if (!ig) {
    const out = settle('failed', 'ACCOUNT_NOT_CONNECTED');
    if (opts.rethrow) throw new ConnectorError('ACCOUNT_NOT_CONNECTED', 'Instagram is not connected');
    return out;
  }
  const r = await ig.send(t.shopId, t.message.conversationId, t.message.text ?? '');
  if (r.status === 'sent') return settle('sent', null, r.externalId);
  const out = settle(r.status, r.code);
  if (opts.rethrow && r.status === 'failed' && (r.code === 'OUTSIDE_MESSAGING_WINDOW' || r.code === 'ACCOUNT_NOT_CONNECTED')) throw new ConnectorError(r.code, r.code === 'OUTSIDE_MESSAGING_WINDOW' ? 'The 24-hour Instagram messaging window has closed' : 'Instagram is not connected');
  return out;
}

/** How to reach a shop conversation: the website channel is internal, Instagram uses the shop's connected official account, other channels need a linked connector account that knows the thread. */
export function locateThread(store: Store, shopId: string, channel: string, externalId: string, ig?: InstagramService): Delivery | undefined {
  if (channel === WEB_CHANNEL) return { kind: 'internal' };
  if (channel === INSTAGRAM_CHANNEL) return ig?.isConnected(shopId) ? { kind: 'instagram' } : undefined;
  for (const acc of store.listAccountsForShop(shopId)) {
    if (channelOf(acc.connectorType) !== channel) continue;
    const c = store.findConversationByProvider(acc.id, externalId);
    if (c) return { kind: 'connector', accountId: acc.id, providerConversationId: c.id };
  }
  return undefined;
}
