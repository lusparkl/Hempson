import { INSTAGRAM_CHANNEL, WEB_CHANNEL, type AgentRepository, AiRunStatus, CatalogRepository, ConversationRepository, OrderRepository, RunPatch, ShopMessageRow, ShopRepository, Store } from '@hepson/database';
import { channelOf } from '../services/channel-bridge';
import type { ConnectorService } from '../services/connector-service';
import type { EventBus, PublicEvent } from '../services/event-bus';
import type { InstagramService } from '../services/instagram';
import type { Notifier } from '../services/notifier';
import { deliverPending } from '../services/shop-sender';
import { checkReply } from './guard';
import { LlmError, type ChatMessage, type LlmClient } from './llm';
import { buildSystemPrompt } from './prompt';
import { RunFacts, TOOLS, runTool } from './tools';

type Logger = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };

const MAX_STEPS = 6;
const MAX_TOOL_CALLS = 8;
const MAX_REPAIRS = 1;
const HISTORY = 20;
const HISTORY_CHARS = 1000;

export type SalesAgentDeps = {
  store: Store;
  bus: EventBus;
  svc: ConnectorService;
  shops: ShopRepository;
  conversations: ConversationRepository;
  catalog: CatalogRepository;
  orders: OrderRepository;
  agent: AgentRepository;
  llm: LlmClient;
  log: Logger;
  maxMessageLength: number;
  notifier?: Notifier;
  instagram?: InstagramService;
};

/** `connector`: reply through a Phase 1 account. `internal`: a channel Hepson itself hosts (website chat): the stored reply is the delivery. */
type Delivery = { kind: 'connector'; accountId: string; providerConversationId: string } | { kind: 'instagram' } | { kind: 'internal' };
type Target = { shopId: string; shopConversationId: string; trigger: ShopMessageRow; delivery: Delivery };

/**
 * The AI sales agent (Feature 6). Reacts only to `message.received` events, which the connector emits for genuinely new
 * inbound messages (never for backfilled history). One run per trigger message (DB-unique), conversations are handled
 * one at a time, and a reply is sent only if the trigger is still the newest message when the reply is ready.
 * The model never sends anything itself: it proposes text, the server validates it (`checkReply`) and sends it once.
 */
export class SalesAgent {
  private chains = new Map<string, Promise<void>>();
  private off: (() => void) | null = null;

  constructor(private d: SalesAgentDeps) {}

  start(): void {
    this.off ??= this.d.bus.subscribeAll((ev) => this.onEvent(ev));
  }
  stop(): void {
    this.off?.();
    this.off = null;
  }
  /** Resolves when no run is in flight (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
  }

  private onEvent(ev: PublicEvent): void {
    if (ev.type !== 'message.received') return;
    const m = ev.payload.message as { id?: string; conversationId?: string; direction?: string } | undefined;
    if (!m?.id || !m.conversationId || m.direction !== 'incoming') return;
    const target = this.resolve(ev.accountId, m.conversationId, m.id);
    if (target) this.enqueue(target);
  }

  /** A new inbound message stored directly in the shop tables (website chat, Instagram webhook). Same rules as a connector message. */
  trigger(shopId: string, conversationId: string, triggerMessageId: string): void {
    if (!this.d.agent.getSettings(shopId).enabled) return;
    const trigger = this.d.conversations.getMessage(shopId, triggerMessageId);
    const conv = this.d.conversations.getConversation(shopId, conversationId);
    if (!trigger || !conv || trigger.direction !== 'incoming' || trigger.conversationId !== conversationId) return;
    const delivery: Delivery | null = conv.conversation.channel === WEB_CHANNEL ? { kind: 'internal' } : conv.conversation.channel === INSTAGRAM_CHANNEL ? { kind: 'instagram' } : null;
    if (delivery) this.enqueue({ shopId, shopConversationId: conversationId, trigger, delivery });
  }

  private enqueue(target: Target): void {
    const prev = this.chains.get(target.shopConversationId) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(() => this.process(target))
      .catch((e) => this.d.log.error({ shopId: target.shopId, err: String(e) }, 'agent run crashed'))
      .finally(() => {
        if (this.chains.get(target.shopConversationId) === next) this.chains.delete(target.shopConversationId);
      });
    this.chains.set(target.shopConversationId, next);
  }

  private resolve(accountId: string, p1ConversationId: string, p1MessageId: string): Target | null {
    const { store, conversations, agent } = this.d;
    const acc = store.getAccount(accountId);
    if (!acc?.shopId || !agent.getSettings(acc.shopId).enabled) return null;
    const p1 = store.getConversation(accountId, p1ConversationId);
    if (!p1) return null;
    const providerConversationId = p1.providerId ?? p1.id;
    const conv = conversations.findConversationByExternal(acc.shopId, channelOf(acc.connectorType), providerConversationId);
    const trigger = conv && conversations.findMessageByExternal(acc.shopId, conv.conversation.id, p1MessageId);
    if (!conv || !trigger || trigger.direction !== 'incoming') return null;
    return { shopId: acc.shopId, shopConversationId: conv.conversation.id, trigger, delivery: { kind: 'connector', accountId, providerConversationId: p1.id } };
  }

  private async process(t: Target): Promise<void> {
    const { agent, conversations, shops, llm, log } = this.d;
    const shop = shops.get(t.shopId);
    if (!shop) return;
    // Re-check after queueing: the owner may have switched the AI off meanwhile.
    if (!agent.getSettings(t.shopId).enabled) return;
    const run = agent.startRun(t.shopId, t.shopConversationId, t.trigger.id);
    if (!run) return; // this message already has a run: never answer it twice
    const finish = (status: AiRunStatus, detail: string | null, extra: RunPatch = {}) =>
      agent.updateRun(t.shopId, run.id, { status, detail, ...extra });

    try {
      if (conversations.getConversation(t.shopId, t.shopConversationId)?.conversation.aiPaused) return void finish('skipped', 'AI_PAUSED');
      if (agent.openEscalation(t.shopId, t.shopConversationId)) return void finish('skipped', 'ESCALATION_OPEN');
      const recent = conversations.listMessages(t.shopId, t.shopConversationId, { limit: HISTORY }).items;
      const newest = recent.at(-1);
      if (newest?.id !== t.trigger.id) return void finish(newest?.direction === 'incoming' ? 'superseded' : 'skipped', newest?.direction === 'incoming' ? 'NEWER_MESSAGE' : 'ALREADY_ANSWERED');

      const conv = conversations.getConversation(t.shopId, t.shopConversationId)!;
      const facts = new RunFacts();
      const ctx = { shopId: t.shopId, conversationId: t.shopConversationId, runId: run.id, catalog: this.d.catalog, orders: this.d.orders, agent, facts, notify: this.d.notifier };
      const customerText = trailingCustomerText(recent);
      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(shop, conv.conversation.channel, agent.getSettings(t.shopId).instructions) },
        ...recent.map(toChat),
      ];

      let requests = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let toolCalls = 0;
      let repairs = 0;
      let model: string = llm.model;
      let reply: string | null = null;
      let blocked: string[] = [];
      const usage = () => ({ model, modelRequests: requests, inputTokens, outputTokens });

      for (let step = 0; step < MAX_STEPS && reply === null; step++) {
        const r = await llm.complete({ messages, tools: TOOLS });
        requests++;
        inputTokens += r.inputTokens;
        outputTokens += r.outputTokens;
        model = r.model;
        if (r.toolCalls.length) {
          messages.push({ role: 'assistant', content: r.content, toolCalls: r.toolCalls });
          for (const c of r.toolCalls) {
            const result = ++toolCalls > MAX_TOOL_CALLS ? JSON.stringify({ error: 'too many tool calls in this turn' }) : runTool(ctx, c.name, c.arguments);
            messages.push({ role: 'tool', toolCallId: c.id, content: result });
          }
          continue;
        }
        if (!r.content) {
          if (facts.escalatedReason) return void finish('escalated', 'ESCALATED', usage());
          blocked = ['the reply was empty'];
        } else {
          blocked = checkReply(r.content, facts, { customerText, maxLength: this.d.maxMessageLength });
          if (!blocked.length) {
            reply = r.content;
            break;
          }
        }
        if (repairs++ >= MAX_REPAIRS) break;
        if (r.content) messages.push({ role: 'assistant', content: r.content });
        messages.push({ role: 'system', content: `Your reply was NOT sent because: ${blocked.join(' ')} Write a corrected reply (or call escalate).` });
      }

      if (reply === null) {
        const reason = facts.escalatedReason ?? 'AI reply could not be verified; please answer the customer';
        const e = agent.escalate(t.shopId, t.shopConversationId, reason, run.id);
        if (e.created) this.d.notifier?.notify({ kind: 'escalation', shopId: t.shopId, conversationId: t.shopConversationId, reason });
        log.warn({ shopId: t.shopId, runId: run.id }, 'agent reply blocked');
        return void finish('escalated', blocked.length ? 'GUARD_BLOCKED' : 'STEP_LIMIT', usage());
      }
      await this.send(t, run.id, reply.trim(), facts.escalatedReason !== null, usage());
    } catch (e) {
      const detail = e instanceof LlmError ? `LLM_${e.status ?? 'ERROR'}` : 'INTERNAL';
      log.warn({ shopId: t.shopId, runId: run.id, detail, err: e instanceof Error ? e.message : String(e) }, 'agent run failed');
      finish('failed', detail);
    }
  }

  private async send(t: Target, runId: string, text: string, escalated: boolean, usage: { model: string; modelRequests: number; inputTokens: number; outputTokens: number }): Promise<void> {
    const { conversations, agent, svc, store } = this.d;
    const done = (status: 'replied' | 'send_uncertain' | 'escalated' | 'failed' | 'superseded', detail: string | null, replyMessageId: string | null = null) =>
      agent.updateRun(t.shopId, runId, { ...usage, status, detail, replyMessageId });
    const ok = escalated ? 'escalated' : 'replied';

    // A newer customer message arrived while the model was working: drop this reply, the next run answers everything.
    if (conversations.listMessages(t.shopId, t.shopConversationId, { limit: 1 }).items.at(-1)?.id !== t.trigger.id) {
      agent.updateRun(t.shopId, runId, { ...usage, status: 'superseded', detail: 'NEWER_MESSAGE' });
      return;
    }
    const { message } = conversations.recordOutbound(t.shopId, t.shopConversationId, { senderType: 'ai', text, deliveryStatus: 'pending' });
    const r = await deliverPending(
      { store, svc, conversations, ig: this.d.instagram },
      { shopId: t.shopId, ...t.delivery, message, idempotencyKey: `ai:${t.trigger.id}` },
    );
    if (r.status === 'sent') return void done(ok, r.code, message.id);
    if (r.status === 'uncertain') return void done('send_uncertain', r.code, message.id);
    if (r.code === 'OUTSIDE_MESSAGING_WINDOW') {
      // The reply cannot reach the customer: hand the conversation to a person instead of staying silent.
      const reason = 'The Instagram 24-hour messaging window closed before the AI reply could be sent';
      const e = agent.escalate(t.shopId, t.shopConversationId, reason, runId);
      if (e.created) this.d.notifier?.notify({ kind: 'escalation', shopId: t.shopId, conversationId: t.shopConversationId, reason });
    }
    done('failed', r.code, message.id);
  }
}

function toChat(m: ShopMessageRow): ChatMessage {
  const att = m.attachments.length ? ` [attachment: ${m.attachments.map((a) => a.kind).join(', ')}]` : '';
  const text = `${(m.text ?? '').slice(0, HISTORY_CHARS)}${att}`.trim();
  return m.direction === 'incoming' ? { role: 'user', content: text } : { role: 'assistant', content: text };
}

/** Customer text since the last outgoing message: the numbers the customer just wrote may legitimately be echoed back. */
function trailingCustomerText(recent: ShopMessageRow[]): string {
  const out: string[] = [];
  for (let i = recent.length - 1; i >= 0 && recent[i]!.direction === 'incoming'; i--) out.push(recent[i]!.text ?? '');
  return out.join('\n');
}
