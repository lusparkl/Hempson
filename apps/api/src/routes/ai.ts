import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors';
import {
  AgentNotFoundError,
  AgentValidationError,
  type AgentRepository,
  type AiRunRow,
  type AuthRepository,
  type EscalationRow,
  type PlanRepository,
  type ShopRepository,
} from '@hepson/database';
import { LlmError } from '../agent/llm';
import type { SalesAgent } from '../agent/sales-agent';
import { RateLimitedError } from '../services/web-chat';
import { RateLimiter } from '../services/rate-limit';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const escP = z.object({ shopId: z.uuid(), escalationId: z.uuid() });
const pageQ = { limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() };
const runsQuery = z.object({ conversationId: z.uuid().optional(), ...pageQ });
const escQuery = z.object({ status: z.enum(['open', 'resolved']).optional(), ...pageQ });
const notifyBody = z.strictObject({ telegramChatId: z.string().nullable() });
const settingsBody = z.strictObject({
  enabled: z.boolean().optional(),
  instructions: z.string().optional(),
  autonomy: z.enum(['approval_required', 'auto_confirm']).optional(),
  autoConfirmMaxMinor: z.number().int().nullable().optional(),
});

/** Model turns per shop and hour in the test chat: it costs the operator tokens but does not count against the plan cap. */
const PLAYGROUND_TURNS_PER_HOUR = 60;

/** A test-chat conversation kept by the client, ending with the customer's new message. */
export const playgroundMessages = (maxLength: number, maxMessages: number) =>
  z
    .array(z.strictObject({ role: z.enum(['customer', 'assistant']), text: z.string().trim().min(1).max(maxLength) }))
    .min(1)
    .max(maxMessages)
    .refine((m) => m.at(-1)?.role === 'customer', 'the last message must be from the customer');

const runView = (r: AiRunRow) => ({
  runId: r.id,
  conversationId: r.conversationId,
  triggerMessageId: r.triggerMessageId,
  status: r.status,
  detail: r.detail,
  model: r.model,
  modelRequests: r.modelRequests,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  replyMessageId: r.replyMessageId,
  createdAt: r.createdAt,
  finishedAt: r.finishedAt,
});
const escalationView = (e: EscalationRow) => ({
  escalationId: e.id,
  conversationId: e.conversationId,
  runId: e.runId,
  reason: e.reason,
  status: e.status,
  createdAt: e.createdAt,
  resolvedAt: e.resolvedAt,
  resolvedByUserId: e.resolvedByUserId,
});

function translate(e: unknown): never {
  if (e instanceof AgentValidationError) throw new ApiError('VALIDATION_ERROR', e.message);
  if (e instanceof AgentNotFoundError) throw new ApiError('NOT_FOUND', e.message);
  throw e;
}

/** AI settings (owner writes, any member reads), the agent's run audit trail and escalations (any member). */
export function registerAiRoutes(
  app: FastifyInstance,
  deps: {
    shops: ShopRepository;
    auth: AuthRepository;
    agent: AgentRepository;
    plans: PlanRepository;
    salesAgent: SalesAgent | null;
    telegramAvailable: boolean;
    maxMessageLength: number;
  },
) {
  const { shops, auth, agent, plans, salesAgent, telegramAvailable } = deps;
  const aiAvailable = salesAgent !== null;
  const playgroundLimit = new RateLimiter(PLAYGROUND_TURNS_PER_HOUR, 3_600_000);
  const playgroundBody = z.strictObject({
    messages: playgroundMessages(deps.maxMessageLength, 40),
    instructions: z.string().max(2000).optional(),
  });
  const requireRole = makeRequireRole(shops, auth);
  const settingsView = async (shopId: string) => {
    const s = await agent.getSettings(shopId);
    // `available` = a model is configured on this server; `enabled` = the owner switched the agent on for this shop.
    return {
      enabled: s.enabled,
      instructions: s.instructions,
      available: aiAvailable,
      autonomy: s.autonomy,
      autoConfirmMaxMinor: s.autoConfirmMaxMinor,
      autonomyChangedAt: s.autonomyChangedAt,
      autonomyChangedBy: s.autonomyChangedBy,
      updatedAt: s.updatedAt || null,
    };
  };

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/ai',
    summary: 'AI agent settings (any member)',
    tag: 'ai',
    auth: 'user',
    params: shopP,
    handler: async ({ req, params }) => {
      await requireRole(req, params.shopId, 'manager');
      return await settingsView(params.shopId);
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/ai',
    summary: 'Switch the AI agent on/off, set owner notes and the autonomy level (D26) (owner). Off and approval_required by default.',
    tag: 'ai',
    auth: 'user',
    params: shopP,
    body: settingsBody,
    handler: async ({ req, params, body }) => {
      await requireRole(req, params.shopId, 'owner');
      try {
        await agent.updateSettings(params.shopId, body, req.user!.user.id);
      } catch (e) {
        translate(e);
      }
      return await settingsView(params.shopId);
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/shops/:shopId/ai/playground',
    summary:
      'Test chat with the shop AI (any member): same prompt, catalog, policies and reply guard as a real reply; nothing is stored or sent (no order, escalation, notification or reply-cap use). Works while the AI is off; `instructions` tries unsaved notes.',
    tag: 'ai',
    auth: 'user',
    params: shopP,
    body: playgroundBody,
    handler: async ({ req, params, body }) => {
      await requireRole(req, params.shopId, 'manager');
      if (!salesAgent) throw new ApiError('NOT_CONFIGURED', 'No AI model is configured on this server');
      if ((await plans.usage(params.shopId)).planExpired) throw new ApiError('FORBIDDEN', 'The paid period has ended: contact Hepson to renew');
      const wait = playgroundLimit.hit(params.shopId);
      if (wait) throw new RateLimitedError(wait);
      try {
        return await salesAgent.playground(params.shopId, body);
      } catch (e) {
        if (e instanceof LlmError) throw new ApiError('TEMPORARY_FAILURE', 'The AI model did not answer, try again');
        throw e;
      }
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/ai/runs',
    summary: 'Agent runs, newest first: outcome, model requests and token usage (any member)',
    tag: 'ai',
    auth: 'user',
    params: shopP,
    query: runsQuery,
    handler: async ({ req, params, query }) => {
      await requireRole(req, params.shopId, 'manager');
      const r = await agent.listRuns(params.shopId, query);
      return { total: r.total, items: r.items.map(runView) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/escalations',
    summary: 'Conversations the agent handed to a human (any member)',
    tag: 'ai',
    auth: 'user',
    params: shopP,
    query: escQuery,
    handler: async ({ req, params, query }) => {
      await requireRole(req, params.shopId, 'manager');
      const r = await agent.listEscalations(params.shopId, query);
      return { total: r.total, items: r.items.map(escalationView) };
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/shops/:shopId/escalations/:escalationId/resolve',
    summary: 'Mark an escalation handled; the agent may answer in that conversation again (any member)',
    tag: 'ai',
    auth: 'user',
    params: escP,
    handler: async ({ req, params }) => {
      await requireRole(req, params.shopId, 'manager');
      try {
        return escalationView(await agent.resolveEscalation(params.shopId, params.escalationId, req.user!.user.id));
      } catch (e) {
        translate(e);
      }
    },
  });

  // `available` = the server has a Telegram bot token; the shop receives messages only when it also has a chat id.
  const notifyView = async (shopId: string) => {
    const n = await agent.getNotifySettings(shopId);
    return { telegram: { available: telegramAvailable, chatId: n.telegramChatId }, updatedAt: n.updatedAt || null };
  };

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/notifications',
    summary: 'Where escalations and order drafts are announced (any member)',
    tag: 'ai',
    auth: 'user',
    params: shopP,
    handler: async ({ req, params }) => {
      await requireRole(req, params.shopId, 'manager');
      return await notifyView(params.shopId);
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/shops/:shopId/notifications',
    summary: 'Set the Telegram chat (numeric id or @channelname; null turns notifications off) (owner)',
    tag: 'ai',
    auth: 'user',
    params: shopP,
    body: notifyBody,
    handler: async ({ req, params, body }) => {
      await requireRole(req, params.shopId, 'owner');
      try {
        await agent.updateNotifySettings(params.shopId, body);
      } catch (e) {
        translate(e);
      }
      return await notifyView(params.shopId);
    },
  });
}
