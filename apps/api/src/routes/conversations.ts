import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import {
  ConversationNotFoundError,
  ConversationValidationError,
  type AuthRepository,
  type ConversationRepository,
  type ConversationWithCustomer,
  type CustomerRow,
  type LastMessage,
  type ShopMessageRow,
  type ShopRepository,
  type Store,
} from '@hepson/database';
import { route } from './define';
import type { ConnectorService } from '../services/connector-service';
import type { InstagramService } from '../services/instagram';
import type { TelegramService } from '../services/telegram';
import { deliverPending, locateThread } from '../services/shop-sender';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const convP = z.object({ shopId: z.uuid(), conversationId: z.uuid() });
const customerP = z.object({ shopId: z.uuid(), customerId: z.uuid() });
const pageQ = { limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() };
const customersQuery = z.object(pageQ);
const convQuery = z.object({ status: z.enum(['open', 'closed']).optional(), customerId: z.uuid().optional(), ...pageQ });
const messagesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), beforeSeq: z.coerce.number().int().min(1).optional() });

const pauseBody = z.strictObject({ paused: z.boolean() });
const readBody = z.strictObject({ seq: z.number().int().min(0).optional() });
const noteBody = z.strictObject({ note: z.string().max(2000) });

const customerView = (c: CustomerRow) => ({
  customerId: c.id,
  channel: c.channel,
  externalId: c.externalId,
  displayName: c.displayName,
  handle: c.handle,
  note: c.note,
  noteUpdatedAt: c.noteUpdatedAt,
  createdAt: c.createdAt,
});
/** `lastMessage` and `unread` (for the calling member) are P10 list fields. */
const conversationView = ({ conversation: c, customer }: ConversationWithCustomer, extra: { lastMessage: LastMessage | null; unread: boolean }) => ({
  conversationId: c.id,
  channel: c.channel,
  externalId: c.externalId,
  status: c.status,
  lastMessageAt: c.lastMessageAt,
  aiPaused: c.aiPaused,
  aiPausedAt: c.aiPausedAt,
  aiPausedByUserId: c.aiPausedByUserId,
  createdAt: c.createdAt,
  customer: customerView(customer),
  lastMessage: extra.lastMessage,
  unread: extra.unread,
});
const messageView = (m: ShopMessageRow) => ({
  messageId: m.id,
  externalId: m.externalId,
  direction: m.direction,
  senderType: m.senderType,
  senderUserId: m.senderUserId,
  text: m.text,
  attachments: m.attachments,
  deliveryStatus: m.deliveryStatus,
  deliveryError: m.deliveryError,
  seq: m.seq,
  occurredAt: m.occurredAt,
});

/**
 * Any shop member reads. Members may also take a conversation over from the AI (pause/resume) and reply as a human
 * (Feature 8); a human reply pauses the AI in that conversation first. Everything else is written by ingestion (F5) or the agent (F6).
 */
export function registerConversationRoutes(
  app: FastifyInstance,
  deps: { shops: ShopRepository; auth: AuthRepository; conversations: ConversationRepository; store: Store; svc: ConnectorService; maxMessageLength: number; ig?: InstagramService; tg?: TelegramService },
) {
  const { shops, auth, conversations, store, svc, maxMessageLength, ig, tg } = deps;
  const requireRole = makeRequireRole(shops, auth);
  const sendBody = z.strictObject({ text: z.string().trim().min(1).max(maxMessageLength) });
  /** Views of conversations with their newest message and this member's unread state. */
  const views = (shopId: string, userId: string, items: ConversationWithCustomer[]) => {
    const ids = items.map((i) => i.conversation.id);
    const last = conversations.lastMessages(shopId, ids);
    const unread = conversations.unreadFor(shopId, userId, ids);
    return items.map((i) => conversationView(i, { lastMessage: last.get(i.conversation.id) ?? null, unread: unread.has(i.conversation.id) }));
  };
  const notFound = (e: unknown): never => {
    if (e instanceof ConversationNotFoundError) throw new ConnectorError('NOT_FOUND', e.message);
    if (e instanceof ConversationValidationError) throw new ConnectorError('VALIDATION_ERROR', e.message);
    throw e;
  };

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/customers',
    summary: 'List customers, newest first (any member)',
    tag: 'conversations',
    auth: 'user',
    params: shopP,
    query: customersQuery,
    handler: ({ req, params, query }) => {
      requireRole(req, params.shopId, 'manager');
      const r = conversations.listCustomers(params.shopId, query);
      return { total: r.total, items: r.items.map(customerView) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/conversations',
    summary: 'List conversations, most recent activity first (any member)',
    tag: 'conversations',
    auth: 'user',
    params: shopP,
    query: convQuery,
    handler: ({ req, params, query }) => {
      requireRole(req, params.shopId, 'manager');
      const r = conversations.listConversations(params.shopId, query);
      return { total: r.total, items: views(params.shopId, req.user!.user.id, r.items) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/conversations/unread-count',
    summary: 'How many conversations have a customer message the calling member has not seen (any member)',
    tag: 'conversations',
    auth: 'user',
    params: shopP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      return { count: conversations.unreadCount(params.shopId, req.user!.user.id) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/customers/:customerId',
    summary: "A customer with the shop's note, contact data from their orders and order totals across conversations (any member)",
    tag: 'conversations',
    auth: 'user',
    params: customerP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      const c = conversations.getCustomer(params.shopId, params.customerId);
      if (!c) throw new ConnectorError('NOT_FOUND', 'customer not found');
      return { ...customerView(c), profile: conversations.customerProfile(params.shopId, c.id) };
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/customers/:customerId/note',
    summary: "Replace the shop's private note about a customer; empty text clears it. Never shown to the AI or the customer (any member)",
    tag: 'conversations',
    auth: 'user',
    params: customerP,
    body: noteBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'manager');
      try {
        return customerView(conversations.setCustomerNote(params.shopId, params.customerId, body.note, req.user!.user.id));
      } catch (e) {
        return notFound(e);
      }
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/conversations/:conversationId/read',
    summary: "Mark the conversation seen by the calling member up to `seq` (default: its newest message); the marker only moves forward (any member)",
    tag: 'conversations',
    auth: 'user',
    params: convP,
    body: readBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'manager');
      const userId = req.user!.user.id;
      try {
        const lastSeenSeq = conversations.markRead(params.shopId, params.conversationId, userId, body.seq);
        return { lastSeenSeq, unread: conversations.unreadFor(params.shopId, userId, [params.conversationId]).has(params.conversationId) };
      } catch (e) {
        return notFound(e);
      }
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/conversations/:conversationId',
    summary: 'Get a conversation with its customer (any member)',
    tag: 'conversations',
    auth: 'user',
    params: convP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      const c = conversations.getConversation(params.shopId, params.conversationId);
      if (!c) throw new ConnectorError('NOT_FOUND', 'conversation not found');
      return views(params.shopId, req.user!.user.id, [c])[0];
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/conversations/:conversationId/messages',
    summary: 'Newest `limit` messages, oldest first; page back with beforeSeq (any member)',
    tag: 'conversations',
    auth: 'user',
    params: convP,
    query: messagesQuery,
    handler: ({ req, params, query }) => {
      requireRole(req, params.shopId, 'manager');
      if (!conversations.getConversation(params.shopId, params.conversationId)) throw new ConnectorError('NOT_FOUND', 'conversation not found');
      const r = conversations.listMessages(params.shopId, params.conversationId, query);
      return { hasMore: r.hasMore, items: r.items.map(messageView) };
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/conversations/:conversationId/ai',
    summary: 'Pause or resume the AI agent in one conversation (human takeover; any member). Idempotent.',
    tag: 'conversations',
    auth: 'user',
    params: convP,
    body: pauseBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'manager');
      try {
        return views(params.shopId, req.user!.user.id, [conversations.setAiPaused(params.shopId, params.conversationId, body.paused, req.user!.user.id)])[0];
      } catch (e) {
        return notFound(e);
      }
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/shops/:shopId/conversations/:conversationId/messages',
    summary: 'Reply to the customer as a human through the linked channel account; pauses the AI in this conversation (any member)',
    tag: 'conversations',
    auth: 'user',
    params: convP,
    body: sendBody,
    status: 201,
    handler: async ({ req, params, body }) => {
      requireRole(req, params.shopId, 'manager');
      const conv = conversations.getConversation(params.shopId, params.conversationId);
      if (!conv) throw new ConnectorError('NOT_FOUND', 'conversation not found');
      const thread = locateThread(store, params.shopId, conv.conversation.channel, conv.conversation.externalId, ig, tg);
      if (!thread) throw new ConnectorError('ACCOUNT_NOT_CONNECTED', 'no linked channel account can reach this conversation');
      // Dry run: the connector's own checks (outbound enabled, account connected, length) run before anything is recorded or paused.
      if (thread.kind === 'connector') await svc.requestSend(thread.accountId, thread.providerConversationId, body.text, `check:${params.conversationId}`, true);
      if (thread.kind === 'instagram') {
        // Same rule as the dry run above: refuse before anything is recorded or paused.
        const blocked = ig?.blockReason(params.shopId, params.conversationId);
        if (blocked) throw new ConnectorError(blocked, blocked === 'OUTSIDE_MESSAGING_WINDOW' ? 'The 24-hour Instagram messaging window has closed' : 'Instagram is not connected');
      }
      if (thread.kind === 'telegram' && tg?.blockReason(params.shopId)) throw new ConnectorError('ACCOUNT_NOT_CONNECTED', 'Telegram is not connected');
      const userId = req.user!.user.id;
      let message: ShopMessageRow;
      try {
        conversations.setAiPaused(params.shopId, params.conversationId, true, userId);
        message = conversations.recordOutbound(params.shopId, params.conversationId, { senderType: 'human', senderUserId: userId, text: body.text, deliveryStatus: 'pending' }).message;
        // Replying means the member has read the conversation.
        conversations.markRead(params.shopId, params.conversationId, userId, message.seq);
      } catch (e) {
        return notFound(e);
      }
      const r = await deliverPending({ store, svc, conversations, ig, tg }, { shopId: params.shopId, ...thread, message, idempotencyKey: `human:${message.id}` });
      return { ...messageView(r.message), aiPaused: true };
    },
  });
}
