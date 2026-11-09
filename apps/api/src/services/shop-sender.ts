import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors';
import { INSTAGRAM_CHANNEL, TELEGRAM_CHANNEL, WEB_CHANNEL, type ConversationRepository, type ShopMessageRow } from '@hepson/database';
import type { InstagramService } from './instagram';
import type { TelegramService } from './telegram';

/** How a reply leaves Hepson: through the official Instagram or Telegram API, or (website chat) by being stored where the visitor reads it. */
export type Delivery = { kind: 'instagram' } | { kind: 'telegram' } | { kind: 'internal' };

export type SenderDeps = { conversations: ConversationRepository; ig?: InstagramService; tg?: TelegramService };

export type SendOutcome = { status: 'sent' | 'uncertain' | 'failed'; code: string | null; message: ShopMessageRow };

/** Sends the text of an already recorded `pending` shop-side message through its channel and reconciles the row. */
export async function deliverPending(d: SenderDeps, t: { shopId: string; message: ShopMessageRow } & Delivery, opts: { rethrow?: boolean } = {}): Promise<SendOutcome> {
  if (t.kind === 'internal') {
    // Nothing external to acknowledge: the row is the message. The generated id marks it as ours, not a platform ack.
    const message = await d.conversations.setDeliveryStatus(t.shopId, t.message.id, 'sent', { externalId: `web:${randomUUID()}` });
    return { status: 'sent', code: null, message };
  }
  if (t.kind === 'instagram') return deliverDirect(d.conversations, d.ig, 'Instagram', t, opts);
  return deliverDirect(d.conversations, d.tg, 'Telegram', t, opts);
}

type DirectChannel = {
  send(shopId: string, conversationId: string, text: string): Promise<{ status: 'sent'; externalId: string } | { status: 'uncertain' | 'failed'; code: string }>;
};

/**
 * One attempt through an official channel API (Instagram, Telegram). The channel checks its connection (and Instagram's
 * 24-hour window, `OUTSIDE_MESSAGING_WINDOW`) before anything is sent; `uncertain` is final. An Instagram echo webhook
 * may have adopted the row first: then it is already `sent`.
 */
async function deliverDirect(
  conversations: ConversationRepository,
  ch: DirectChannel | undefined,
  name: string,
  t: { shopId: string; message: ShopMessageRow },
  opts: { rethrow?: boolean },
): Promise<SendOutcome> {
  const settle = async (status: 'sent' | 'uncertain' | 'failed', code: string | null, externalId?: string): Promise<SendOutcome> => {
    const cur = (await conversations.getMessage(t.shopId, t.message.id))!;
    if (cur.deliveryStatus !== 'pending' && !(cur.deliveryStatus === 'uncertain' && status === 'sent'))
      return { status: cur.deliveryStatus === 'sent' ? 'sent' : status, code, message: cur };
    const message = await conversations.setDeliveryStatus(t.shopId, t.message.id, status, { externalId, error: code ?? undefined });
    return { status, code, message };
  };
  if (!ch) {
    const out = await settle('failed', 'ACCOUNT_NOT_CONNECTED');
    if (opts.rethrow) throw new ApiError('ACCOUNT_NOT_CONNECTED', `${name} is not connected`);
    return out;
  }
  const r = await ch.send(t.shopId, t.message.conversationId, t.message.text ?? '');
  if (r.status === 'sent') return await settle('sent', null, r.externalId);
  const out = await settle(r.status, r.code);
  if (opts.rethrow && r.status === 'failed' && (r.code === 'OUTSIDE_MESSAGING_WINDOW' || r.code === 'ACCOUNT_NOT_CONNECTED'))
    throw new ApiError(r.code, r.code === 'OUTSIDE_MESSAGING_WINDOW' ? 'The 24-hour Instagram messaging window has closed' : `${name} is not connected`);
  return out;
}

/**
 * Sends a fixed server text (payment link, reminder) to the customer of a conversation through whatever channel reaches
 * it, recorded as a `system` message. One attempt, same rules as any reply; never throws.
 */
export async function sendSystemMessage(
  d: SenderDeps,
  shopId: string,
  conversationId: string,
  text: string,
): Promise<{ status: 'sent' | 'uncertain' | 'failed'; code: string | null }> {
  const conv = await d.conversations.getConversation(shopId, conversationId);
  if (!conv) return { status: 'failed', code: 'NOT_FOUND' };
  const thread = await locateThread(shopId, conv.conversation.channel, d.ig, d.tg);
  if (!thread) return { status: 'failed', code: 'ACCOUNT_NOT_CONNECTED' };
  const { message } = await d.conversations.recordOutbound(shopId, conversationId, { senderType: 'system', text, deliveryStatus: 'pending' });
  const r = await deliverPending(d, { shopId, ...thread, message });
  return { status: r.status, code: r.code };
}

/** How to reach a shop conversation: the website channel is internal, Instagram and Telegram use the shop's connected official account or bot. */
export async function locateThread(shopId: string, channel: string, ig?: InstagramService, tg?: TelegramService): Promise<Delivery | undefined> {
  if (channel === WEB_CHANNEL) return { kind: 'internal' };
  if (channel === INSTAGRAM_CHANNEL) return (await ig?.isConnected(shopId)) ? { kind: 'instagram' } : undefined;
  if (channel === TELEGRAM_CHANNEL) return (await tg?.isConnected(shopId)) ? { kind: 'telegram' } : undefined;
  return undefined;
}
