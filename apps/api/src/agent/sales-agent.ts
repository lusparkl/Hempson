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

type RunUsage = { model: string; modelRequests: number; inputTokens: number; outputTokens: number };
type Turn = { reply: string | null; silentEscalation: boolean; blocked: string[]; trace: ToolTrace[]; usage: RunUsage };
export type ToolTrace = { name: string; arguments: string; result: string };
/** `blocked` = the reply guard rejected the answer twice; `step_limit` = the model never answered. A real run escalates in both. */
export type PlaygroundResult = {
  outcome: 'replied' | 'escalated' | 'blocked' | 'step_limit';
  reply: string | null;
  escalation: string | null;
  blocked: string[];
  tools: ToolTrace[];
  usage: RunUsage;
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
  async trigger(shopId: string, conversationId: string, triggerMessageId: string): Promise<void> {
    if (!(await this.d.agent.getSettings(shopId)).enabled) return;
    const trigger = await this.d.conversations.getMessage(shopId, triggerMessageId);
    const conv = await this.d.conversations.getConversation(shopId, conversationId);
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
    const { agent, conversations, shops, log } = this.d;
    const shop = await shops.get(t.shopId);
    if (!shop) return;
    // Re-check after queueing: the owner may have switched the AI off meanwhile.
    if (!(await agent.getSettings(t.shopId)).enabled) return;
    const run = await agent.startRun(t.shopId, t.shopConversationId, t.trigger.id);
    if (!run) return; // this message already has a run: never answer it twice
    const finish = async (status: AiRunStatus, detail: string | null, extra: RunPatch = {}) => await agent.updateRun(t.shopId, run.id, { status, detail, ...extra });

    try {
      if ((await conversations.getConversation(t.shopId, t.shopConversationId))?.conversation.aiPaused) return void finish('skipped', 'AI_PAUSED');
      if (await agent.openEscalation(t.shopId, t.shopConversationId)) return void finish('skipped', 'ESCALATION_OPEN');
      const recent = (await conversations.listMessages(t.shopId, t.shopConversationId, { limit: HISTORY })).items;
      const newest = recent.at(-1);
      if (newest?.id !== t.trigger.id)
        return void finish(newest?.direction === 'incoming' ? 'superseded' : 'skipped', newest?.direction === 'incoming' ? 'NEWER_MESSAGE' : 'ALREADY_ANSWERED');
      const quota = await this.d.plans.usage(t.shopId, run.id);
      if (quota.capReached) return void (await this.atCap(t, run.id, quota, shop.defaultLanguage));

      const conv = (await conversations.getConversation(t.shopId, t.shopConversationId))!;
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
      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(shop, conv.conversation.channel, (await agent.getSettings(t.shopId)).instructions) },
        ...recent.map(toChat),
      ];
      const turn = await this.converse(messages, ctx, trailingCustomerText(recent));
      if (turn.silentEscalation) return void finish('escalated', 'ESCALATED', turn.usage);
      if (turn.reply === null) {
        const reason = facts.escalatedReason ?? 'AI reply could not be verified; please answer the customer';
        const e = await agent.escalate(t.shopId, t.shopConversationId, reason, run.id);
        if (e.created) this.d.notifier?.notify({ kind: 'escalation', shopId: t.shopId, conversationId: t.shopConversationId, reason });
        log.warn({ shopId: t.shopId, runId: run.id }, 'agent reply blocked');
        return void finish('escalated', turn.blocked.length ? 'GUARD_BLOCKED' : 'STEP_LIMIT', turn.usage);
      }
      await this.send(t, run.id, turn.reply.trim(), facts.escalatedReason !== null, turn.usage);
    } catch (e) {
      const detail = e instanceof LlmError ? `LLM_${e.status ?? 'ERROR'}` : 'INTERNAL';
      log.warn({ shopId: t.shopId, runId: run.id, detail, err: e instanceof Error ? e.message : String(e) }, 'agent run failed');
      await finish('failed', detail);
    }
  }

  /**
   * The model/tool loop shared by real runs and the playground: tools run until the model answers, the answer passes
   * `checkReply` or gets one repair attempt. `silentEscalation` = the model escalated and wrote nothing.
   */
  private async converse(messages: ChatMessage[], ctx: ToolContext, customerText: string): Promise<Turn> {
    const { llm } = this.d;
    // Photo search is offered only when this server has a vision model (P9).
    const tools = ctx.photoSearch ? TOOLS : TOOLS.filter((t) => t.name !== 'search_by_photo');
    const trace: ToolTrace[] = [];
    let requests = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCalls = 0;
    let repairs = 0;
    let model: string = llm.model;
    let blocked: string[] = [];
    const done = (reply: string | null, silentEscalation = false): Turn => ({
      reply,
      silentEscalation,
      blocked,
      trace,
      usage: { model, modelRequests: requests, inputTokens, outputTokens },
    });

    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await llm.complete({ messages, tools });
      requests++;
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      model = r.model;
      if (r.toolCalls.length) {
        messages.push({ role: 'assistant', content: r.content, toolCalls: r.toolCalls });
        for (const c of r.toolCalls) {
          const result = ++toolCalls > MAX_TOOL_CALLS ? JSON.stringify({ error: 'too many tool calls in this turn' }) : await runTool(ctx, c.name, c.arguments);
          trace.push({ name: c.name, arguments: c.arguments, result });
          messages.push({ role: 'tool', toolCallId: c.id, content: result });
        }
        continue;
      }
      if (!r.content) {
        if (ctx.facts.escalatedReason) return done(null, true);
        blocked = ['the reply was empty'];
      } else {
        blocked = checkReply(r.content, ctx.facts, { customerText, maxLength: this.d.maxMessageLength });
        if (!blocked.length) return done(r.content);
      }
      if (repairs++ >= MAX_REPAIRS) break;
      if (r.content) messages.push({ role: 'assistant', content: r.content });
      messages.push({ role: 'system', content: `Your reply was NOT sent because: ${blocked.join(' ')} Write a corrected reply (or call escalate).` });
    }
    return done(null);
  }

  /**
   * The owner's test chat: the same prompt, tools and reply guard as a real run, over a conversation the dashboard keeps.
   * Nothing is stored or sent: no run, message, order draft, escalation or notification, and no reply cap is used.
   * Works while the agent is switched off; `instructions` lets the owner try unsaved notes.
   */
  async playground(shopId: string, input: { messages: Array<{ role: 'customer' | 'assistant'; text: string }>; instructions?: string }): Promise<PlaygroundResult> {
    const shop = await this.d.shops.get(shopId);
    if (!shop) throw new Error('shop not found');
    const history = input.messages.slice(-HISTORY);
    const facts = new RunFacts();
    const ctx: ToolContext = {
      shopId,
      conversationId: '',
      customerId: '',
      runId: '',
      catalog: this.d.catalog,
      orders: this.d.orders,
      agent: this.d.agent,
      facts,
      policies: this.d.policies,
      deliveryRepo: this.d.deliveryRepo,
      delivery: this.d.delivery,
      sandbox: true,
    };
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(shop, WEB_CHANNEL, input.instructions ?? (await this.d.agent.getSettings(shopId)).instructions) },
      ...history.map((m): ChatMessage => ({ role: m.role === 'customer' ? 'user' : 'assistant', content: m.text.slice(0, HISTORY_CHARS) })),
    ];
    const customerText: string[] = [];
    for (let i = history.length - 1; i >= 0 && history[i]!.role === 'customer'; i--) customerText.push(history[i]!.text);
    const turn = await this.converse(messages, ctx, customerText.join('\n'));
    const outcome = turn.reply !== null ? (facts.escalatedReason ? 'escalated' : 'replied') : turn.silentEscalation ? 'escalated' : turn.blocked.length ? 'blocked' : 'step_limit';
    return { outcome, reply: turn.reply?.trim() ?? null, escalation: facts.escalatedReason, blocked: turn.blocked, tools: turn.trace, usage: turn.usage };
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
    const e = await agent.escalate(t.shopId, t.shopConversationId, reason, runId);
    if (e.created) {
      const text = uk ? 'Дякуємо за повідомлення! Менеджер відповість вам найближчим часом.' : 'Thank you for your message! A manager will reply to you shortly.';
      await sendSystemMessage({ conversations, ig: this.d.instagram, tg: this.d.telegram }, t.shopId, t.shopConversationId, text);
    }
    if (u.aiReplyCap !== null && (await this.d.plans.claimCapNotice(t.shopId, u.month)))
      this.d.notifier?.notify({ kind: 'ai_quota', shopId: t.shopId, month: u.month, cap: u.aiReplyCap });
    this.d.log.info({ shopId: t.shopId, runId, month: u.month, cap: u.aiReplyCap }, 'ai reply cap reached');
    await agent.updateRun(t.shopId, runId, { status: 'escalated', detail: 'AI_REPLY_CAP' });
  }

  private async send(t: Target, runId: string, text: string, escalated: boolean, usage: RunUsage): Promise<void> {
    const { conversations, agent } = this.d;
    const done = async (status: 'replied' | 'send_uncertain' | 'escalated' | 'failed' | 'superseded', detail: string | null, replyMessageId: string | null = null) =>
      await agent.updateRun(t.shopId, runId, { ...usage, status, detail, replyMessageId });
    const ok = escalated ? 'escalated' : 'replied';

    // A newer customer message arrived while the model was working: drop this reply, the next run answers everything.
    // Server messages sent meanwhile (a payment link after auto-confirm) do not count.
    const lastIncoming = (await conversations.listMessages(t.shopId, t.shopConversationId, { limit: 20 })).items.filter((m) => m.direction === 'incoming').at(-1);
    if (lastIncoming && lastIncoming.id !== t.trigger.id) {
      await agent.updateRun(t.shopId, runId, { ...usage, status: 'superseded', detail: 'NEWER_MESSAGE' });
      return;
    }
    const { message } = await conversations.recordOutbound(t.shopId, t.shopConversationId, { senderType: 'ai', text, deliveryStatus: 'pending' });
    const r = await deliverPending({ conversations, ig: this.d.instagram, tg: this.d.telegram }, { shopId: t.shopId, ...t.delivery, message });
    if (r.status === 'sent') return void done(ok, r.code, message.id);
    if (r.status === 'uncertain') return void done('send_uncertain', r.code, message.id);
    if (r.code === 'OUTSIDE_MESSAGING_WINDOW') {
      // The reply cannot reach the customer: hand the conversation to a person instead of staying silent.
      const reason = 'The Instagram 24-hour messaging window closed before the AI reply could be sent';
      const e = await agent.escalate(t.shopId, t.shopConversationId, reason, runId);
      if (e.created) this.d.notifier?.notify({ kind: 'escalation', shopId: t.shopId, conversationId: t.shopConversationId, reason });
    }
    await done('failed', r.code, message.id);
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
