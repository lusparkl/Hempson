import { randomUUID } from 'node:crypto';
import { ConnectorError } from '@hepson/connector-core';
import { WEB_CHANNEL, type ConversationRepository, type ShopMessageRow, type Store } from '@hepson/database';
import { channelOf } from './channel-bridge';
import type { ConnectorService } from './connector-service';

/** How a reply leaves Hepson: through a connector account, or (website chat) by being stored where the visitor reads it. */
export type Delivery = { kind: 'connector'; accountId: string; providerConversationId: string } | { kind: 'internal' };

export type SendOutcome = { status: 'sent' | 'uncertain' | 'failed'; code: string | null; message: ShopMessageRow };

/**
 * Sends the text of an already recorded `pending` shop-side message through the connector and reconciles the row.
 * `requestSend` throws only before anything is queued, so a throw means nothing was sent (row marked `failed`, error
 * rethrown for `rethrow`, else reported as a failed outcome). `uncertain` is never retried (connector rule).
 */
export async function deliverPending(
  d: { store: Store; svc: ConnectorService; conversations: ConversationRepository },
  t: { shopId: string; message: ShopMessageRow; idempotencyKey: string } & Delivery,
  opts: { rethrow?: boolean } = {},
): Promise<SendOutcome> {
  const { store, svc, conversations } = d;
  if (t.kind === 'internal') {
    // Nothing external to acknowledge: the row is the message. The generated id marks it as ours, not a platform ack.
    const message = conversations.setDeliveryStatus(t.shopId, t.message.id, 'sent', { externalId: `web:${randomUUID()}` });
    return { status: 'sent', code: null, message };
  }
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

/** How to reach a shop conversation: the website channel is internal, other channels need a linked connector account that knows the thread. */
export function locateThread(store: Store, shopId: string, channel: string, externalId: string): Delivery | undefined {
  if (channel === WEB_CHANNEL) return { kind: 'internal' };
  for (const acc of store.listAccountsForShop(shopId)) {
    if (channelOf(acc.connectorType) !== channel) continue;
    const c = store.findConversationByProvider(acc.id, externalId);
    if (c) return { kind: 'connector', accountId: acc.id, providerConversationId: c.id };
  }
  return undefined;
}
