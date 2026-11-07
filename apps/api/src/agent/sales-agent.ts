import {
  INSTAGRAM_CHANNEL,
  TELEGRAM_CHANNEL,
  WEB_CHANNEL,
  type AgentRepository,
  type AiUsage,
  AiRunStatus,
  CatalogRepository,
  ConversationRepository,
  DeliveryRepository,
  OrderRepository,
  type PaymentRepository,
  type PlanRepository,
  PolicyRepository,
  RunPatch,
  ShopMessageRow,
  ShopRepository,
} from '@hepson/database';
import type { DeliveryService } from '../services/delivery';
import type { PaymentService } from '../services/payments';
import type { InstagramService } from '../services/instagram';
import type { Notifier } from '../services/notifier';
import type { TelegramService } from '../services/telegram';
import { PhotoSearchService } from '../services/photo-search';
import { deliverPending, sendSystemMessage, type Delivery } from '../services/shop-sender';
import { checkReply } from './guard';
import { LlmError, type ChatMessage, type LlmClient } from './llm';
import { buildSystemPrompt } from './prompt';
import { RunFacts, TOOLS, runTool, type ToolContext } from './tools';

type PhotoSearchFn = NonNullable<ToolContext['photoSearch']>;

type Logger = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };

const MAX_STEPS = 8;
const MAX_TOOL_CALLS = 12;
const MAX_REPAIRS = 1;
const HISTORY = 20;
const HISTORY_CHARS = 1000;

export type SalesAgentDeps = {
  shops: ShopRepository;
  conversations: ConversationRepository;
  catalog: CatalogRepository;
  orders: OrderRepository;
  agent: AgentRepository;
  policies: PolicyRepository;
  /** P7: the monthly AI-reply cap is checked before any model call. */
  plans: PlanRepository;
  deliveryRepo: DeliveryRepository;
  delivery?: DeliveryService;
  paymentRepo?: PaymentRepository;
  payments?: PaymentService;
  llm: LlmClient;
  log: Logger;
  maxMessageLength: number;
  notifier?: Notifier;
  instagram?: InstagramService;
  telegram?: TelegramService;
  /** P9 photo search; absent when no vision model is configured. */
  photos?: PhotoSearchService;
};

type Target = { shopId: string; shopConversationId: string; trigger: ShopMessageRow; delivery: Delivery };

/**
 * The AI sales agent (Feature 6). Channels call `trigger` for each genuinely new inbound message (never for backfilled
 * history). One run per trigger message (DB-unique), conversations are handled one at a time, and a reply is sent only
 * if the trigger is still the newest message when the reply is ready.
 * The model never sends anything itself: it proposes text, the server validates it (`checkReply`) and sends it once.
 */
export class SalesAgent {
  private chains = new Map<string, Promise<void>>();

  constructor(private d: SalesAgentDeps) {}

  /** Resolves when no run is in flight (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
  }

  /** A new inbound message stored in the shop tables (website chat, Instagram, Telegram). */
  trigger(shopId: string, conversationId: string, triggerMessageId: string): void {
    if (!this.d.agent.getSettings(shopId).enabled) return;
    const trigger = this.d.conversations.getMessage(shopId, triggerMessageId);
    const conv = this.d.conversations.getConversation(shopId, conversationId);
    if (!trigger || !conv || trigger.direction !== 'incoming' || trigger.conversationId !== conversationId) return;
    const ch = conv.conversation.channel;
    const delivery: Delivery | null =
      ch === WEB_CHANNEL ? { kind: 'internal' } : ch === INSTAGRAM_CHANNEL ? { kind: 'instagram' } : ch === TELEGRAM_CHANNEL ? { kind: 'telegram' } : null;
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

  private async process(t: Target): Promise<void> {
    const { agent, conversations, shops, llm, log } = this.d;
    const shop = shops.get(t.shopId);
    if (!shop) return;
    // Re-check after queueing: the owner may have switched the AI off meanwhile.
    if (!agent.getSettings(t.shopId).enabled) return;
    const run = agent.startRun(t.shopId, t.shopConversationId, t.trigger.id);
    if (!run) return; // this message already has a run: never answer it twice
    const finish = (status: AiRunStatus, detail: string | null, extra: RunPatch = {}) => agent.updateRun(t.shopId, run.id, { status, detail, ...extra });

    try {
      if (conversations.getConversation(t.shopId, t.shopConversationId)?.conversation.aiPaused) return void finish('skipped', 'AI_PAUSED');
      if (agent.openEscalation(t.shopId, t.shopConversationId)) return void finish('skipped', 'ESCALATION_OPEN');
      const recent = conversations.listMessages(t.shopId, t.shopConversationId, { limit: HISTORY }).items;
      const newest = recent.at(-1);
      if (newest?.id !== t.trigger.id)
        return void finish(newest?.direction === 'incoming' ? 'superseded' : 'skipped', newest?.direction === 'incoming' ? 'NEWER_MESSAGE' : 'ALREADY_ANSWERED');
      const quota = this.d.plans.usage(t.shopId, run.id);
      if (quota.capReached) return void (await this.atCap(t, run.id, quota, shop.defaultLanguage));

      const conv = conversations.getConversation(t.shopId, t.shopConversationId)!;
      const facts = new RunFacts();
      const ctx = {
        shopId: t.shopId,
        conversationId: t.shopConversationId,
        customerId: conv.customer.id,
        runId: run.id,
        catalog: this.d.catalog,
        orders: this.d.orders,
        agent,
        facts,
        policies: this.d.policies,
        deliveryRepo: this.d.deliveryRepo,
        delivery: this.d.delivery,
        paymentRepo: this.d.paymentRepo,
        payments: this.d.payments,
        notify: this.d.notifier,
        photoSearch: this.d.photos ? this.photoSearch(t.shopId, conv.conversation.channel, recent) : undefined,
      };
      const customerText = trailingCustomerText(recent);
      // Photo search is offered only when this server has a vision model (P9).
      const tools = ctx.photoSearch ? TOOLS : TOOLS.filter((t) => t.name !== 'search_by_photo');
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
        const r = await llm.complete({ messages, tools });
        requests++;
        inputTokens += r.inputTokens;
        outputTokens += r.outputTokens;
        model = r.model;
        if (r.toolCalls.length) {
          messages.push({ role: 'assistant', content: r.content, toolCalls: r.toolCalls });
          for (const c of r.toolCalls) {
            const result = ++toolCalls > MAX_TOOL_CALLS ? JSON.stringify({ error: 'too many tool calls in this turn' }) : await runTool(ctx, c.name, c.arguments);
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

  /** One photo search per run, for the newest readable photo the customer sent since the last reply (computed on first use). */
  private photoSearch(shopId: string, channel: string, recent: ShopMessageRow[]): PhotoSearchFn {
    const photos = this.d.photos!;
    const trailing: ShopMessageRow[] = [];
    for (let i = recent.length - 1; i >= 0 && recent[i]!.direction === 'incoming'; i--) trailing.unshift(recent[i]!);
    let result: ReturnType<PhotoSearchFn> | undefined;
    return (limit) =>
      (result ??= (async () => {
        const pick = PhotoSearchService.pickPhoto(trailing);
        if (!pick) return { status: 'no_photo' as const };
        const image = await photos.loadCustomerImage(shopId, channel, pick.ref);
        return image ? photos.search(shopId, image, limit) : { status: 'unreadable' as const };
      })());
  }

  /**
   * P7: this month's AI-reply cap is reached. No model call: the conversation goes to a person, the customer gets one
   * fixed holding text (never silence), and the owner gets one notice per shop and month instead of one per escalation.
   */
  private async atCap(t: Target, runId: string, u: AiUsage, language: string): Promise<void> {
    const { agent, conversations } = this.d;
    const uk = language.toLowerCase().startsWith('uk');
    const reason = uk ? 'Ліміт відповідей ШІ на цей місяць вичерпано: дайте відповідь клієнту.' : 'The monthly AI reply limit is reached: please answer the customer.';
    const e = agent.escalate(t.shopId, t.shopConversationId, reason, runId);
    if (e.created) {
      const text = uk ? 'Дякуємо за повідомлення! Менеджер відповість вам найближчим часом.' : 'Thank you for your message! A manager will reply to you shortly.';
      await sendSystemMessage({ conversations, ig: this.d.instagram, tg: this.d.telegram }, t.shopId, t.shopConversationId, text);
    }
    if (u.aiReplyCap !== null && this.d.plans.claimCapNotice(t.shopId, u.month)) this.d.notifier?.notify({ kind: 'ai_quota', shopId: t.shopId, month: u.month, cap: u.aiReplyCap });
    this.d.log.info({ shopId: t.shopId, runId, month: u.month, cap: u.aiReplyCap }, 'ai reply cap reached');
    agent.updateRun(t.shopId, runId, { status: 'escalated', detail: 'AI_REPLY_CAP' });
  }

  private async send(
    t: Target,
    runId: string,
    text: string,
    escalated: boolean,
    usage: { model: string; modelRequests: number; inputTokens: number; outputTokens: number },
  ): Promise<void> {
    const { conversations, agent } = this.d;
    const done = (status: 'replied' | 'send_uncertain' | 'escalated' | 'failed' | 'superseded', detail: string | null, replyMessageId: string | null = null) =>
      agent.updateRun(t.shopId, runId, { ...usage, status, detail, replyMessageId });
    const ok = escalated ? 'escalated' : 'replied';

    // A newer customer message arrived while the model was working: drop this reply, the next run answers everything.
    // Server messages sent meanwhile (a payment link after auto-confirm) do not count.
    const lastIncoming = conversations
      .listMessages(t.shopId, t.shopConversationId, { limit: 20 })
      .items.filter((m) => m.direction === 'incoming')
      .at(-1);
    if (lastIncoming && lastIncoming.id !== t.trigger.id) {
      agent.updateRun(t.shopId, runId, { ...usage, status: 'superseded', detail: 'NEWER_MESSAGE' });
      return;
    }
    const { message } = conversations.recordOutbound(t.shopId, t.shopConversationId, { senderType: 'ai', text, deliveryStatus: 'pending' });
    const r = await deliverPending({ conversations, ig: this.d.instagram, tg: this.d.telegram }, { shopId: t.shopId, ...t.delivery, message });
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
