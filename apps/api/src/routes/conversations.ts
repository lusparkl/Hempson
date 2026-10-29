import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import { ConversationNotFoundError, ConversationValidationError, type AuthRepository, type ConversationRepository, type ConversationWithCustomer, type CustomerRow, type ShopMessageRow, type ShopRepository, type Store } from '@hepson/database';
import { route } from './define';
import type { ConnectorService } from '../services/connector-service';
import { deliverPending, locateThread } from '../services/shop-sender';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const convP = z.object({ shopId: z.uuid(), conversationId: z.uuid() });
const pageQ = { limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() };
const customersQuery = z.object(pageQ);
const convQuery = z.object({ status: z.enum(['open', 'closed']).optional(), customerId: z.uuid().optional(), ...pageQ });
const messagesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), beforeSeq: z.coerce.number().int().min(1).optional() });

const pauseBody = z.strictObject({ paused: z.boolean() });

const customerView = (c: CustomerRow) => ({ customerId: c.id, channel: c.channel, externalId: c.externalId, displayName: c.displayName, handle: c.handle, createdAt: c.createdAt });
const conversationView = ({ conversation: c, customer }: ConversationWithCustomer) => ({
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
  deps: { shops: ShopRepository; auth: AuthRepository; conversations: ConversationRepository; store: Store; svc: ConnectorService; maxMessageLength: number },
) {
  const { shops, auth, conversations, store, svc, maxMessageLength } = deps;
  const requireRole = makeRequireRole(shops, auth);
  const sendBody = z.strictObject({ text: z.string().trim().min(1).max(maxMessageLength) });
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
      return { total: r.total, items: r.items.map(conversationView) };
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
      return conversationView(c);
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
        return conversationView(conversations.setAiPaused(params.shopId, params.conversationId, body.paused, req.user!.user.id));
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
      const thread = locateThread(store, params.shopId, conv.conversation.channel, conv.conversation.externalId);
      if (!thread) throw new ConnectorError('ACCOUNT_NOT_CONNECTED', 'no linked channel account can reach this conversation');
      // Dry run: the connector's own checks (outbound enabled, account connected, length) run before anything is recorded or paused.
      if (thread.kind === 'connector') await svc.requestSend(thread.accountId, thread.providerConversationId, body.text, `check:${params.conversationId}`, true);
      const userId = req.user!.user.id;
      let message: ShopMessageRow;
      try {
        conversations.setAiPaused(params.shopId, params.conversationId, true, userId);
        message = conversations.recordOutbound(params.shopId, params.conversationId, { senderType: 'human', senderUserId: userId, text: body.text, deliveryStatus: 'pending' }).message;
      } catch (e) {
        return notFound(e);
      }
      const r = await deliverPending({ store, svc, conversations }, { shopId: params.shopId, ...thread, message, idempotencyKey: `human:${message.id}` });
      return { ...messageView(r.message), aiPaused: true };
    },
  });
}
