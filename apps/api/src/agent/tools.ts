import { z } from 'zod';
import { ConnectorError } from '@hepson/connector-core';
import {
  OrderValidationError,
  POLICY_TOPICS,
  normalizeUaPhone,
  type AgentRepository,
  type CatalogRepository,
  type DeliveryRepository,
  type OrderDraft,
  type OrderQuote,
  type OrderRepository,
  type PaymentMethod,
  type PolicyRepository,
  type PolicyTopic,
  type ProductWithVariants,
  effectivePrice,
} from '@hepson/database';
import type { DeliveryService } from '../services/delivery';
import type { Notifier } from '../services/notifier';
import type { ToolSpec } from './llm';

export const formatMoney = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

/** Everything the tools showed the model in one run. The reply guard accepts a price or stock figure only if it is in here. */
export class RunFacts {
  prices = new Set<number>();
  stocks = new Set<number>();
  quantities = new Set<number>();
  productLookups = 0;
  escalatedReason: string | null = null;
  draftId: string | null = null;
  /** Policy topics looked up in this run; the value is the text, or null when the shop has none (P3). */
  policies = new Map<PolicyTopic, string | null>();
  /** Every number that appears in a policy text returned in this run. */
  policyNumbers = new Set<number>();
  /** Nova Poshta cities and branches the lookup tools returned in this run (refs are only accepted from here). */
  npCities = new Map<string, string>();
  npBranches = new Map<string, { cityRef: string; name: string }>();
  /** Payment methods `get_checkout_options` offered in this run, or null if it was not called. */
  paymentMethods: PaymentMethod[] | null = null;
  orderStatusLookups = 0;
  ttns = new Set<string>();
}

export type ToolContext = {
  shopId: string;
  conversationId: string;
  customerId: string;
  runId: string;
  catalog: CatalogRepository;
  orders: OrderRepository;
  agent: AgentRepository;
  facts: RunFacts;
  policies: PolicyRepository;
  deliveryRepo: DeliveryRepository;
  /** Absent when this server has no credential store; NP lookups then answer with an error. */
  delivery?: DeliveryService;
  notify?: Notifier;
};

const items = z.array(z.strictObject({ sku: z.string().trim().min(1).max(64), quantity: z.number().int().min(1).max(1000) })).min(1).max(20);
const searchArgs = z.strictObject({ query: z.string().trim().max(200).default(''), limit: z.number().int().min(1).max(5).default(5) });
const skuArgs = z.strictObject({ sku: z.string().trim().min(1).max(64) });
const quoteArgs = z.strictObject({ items });
const escalateArgs = z.strictObject({ reason: z.string().trim().min(1).max(500) });
const policyArgs = z.strictObject({ topic: z.enum(POLICY_TOPICS) });
const cityArgs = z.strictObject({ query: z.string().trim().min(2).max(100) });
const branchArgs = z.strictObject({ cityRef: z.string().trim().min(1).max(64), query: z.string().trim().max(100).default('') });
const checkoutArgs = z.strictObject({ phone: z.string().trim().max(40).optional() });
const noArgs = z.strictObject({});
const draftArgs = z.strictObject({
  items,
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(5).max(40),
  cityRef: z.string().trim().min(1).max(64),
  branchRef: z.string().trim().min(1).max(64),
  paymentMethod: z.enum(['cod', 'prepaid']),
  note: z.string().trim().max(1000).optional(),
});

const itemsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  items: {
    type: 'object',
    properties: { sku: { type: 'string', description: 'Variant SKU exactly as returned by a product tool' }, quantity: { type: 'integer', minimum: 1 } },
    required: ['sku', 'quantity'],
    additionalProperties: false,
  },
};

export const TOOLS: ToolSpec[] = [
  {
    name: 'search_products',
    description: 'Search the shop catalog by words (name, description, SKU, size/color). Returns active products with variants, prices and stock. Use 1-3 key words (product name, type), not a whole sentence. Use before saying anything about a product.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'get_variant',
    description: 'Exact price and stock of one variant by SKU.',
    parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false },
  },
  {
    name: 'quote_order',
    description: 'Compute line prices and the total for SKUs and quantities, checking stock. Use this for any total; never add prices yourself. Does not create an order.',
    parameters: { type: 'object', properties: { items: itemsSchema }, required: ['items'], additionalProperties: false },
  },
  {
    name: 'get_policy',
    description: "The shop's own text about delivery (terms, times, costs), returns/exchanges, payment, or opening hours. Call it before saying anything on these topics and quote only what it returns. If it has no text, call escalate.",
    parameters: { type: 'object', properties: { topic: { type: 'string', enum: [...POLICY_TOPICS] } }, required: ['topic'], additionalProperties: false },
  },
  {
    name: 'find_np_city',
    description: 'Find the Nova Poshta city the customer named. Returns up to 5 cities with cityRef. If several match, ask the customer which one (use the area).',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'City name as the customer wrote it' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'find_np_branch',
    description: 'Find a Nova Poshta branch or parcel locker in a city returned by find_np_city in this turn. Query by branch number or street. Returns up to 5 with branchRef.',
    parameters: { type: 'object', properties: { cityRef: { type: 'string' }, query: { type: 'string', description: 'Branch number (e.g. "5") or street' } }, required: ['cityRef', 'query'], additionalProperties: false },
  },
  {
    name: 'get_checkout_options',
    description: 'Payment methods this customer may choose for this shop. Offer only these. Pass the phone once the customer gave it.',
    parameters: { type: 'object', properties: { phone: { type: 'string' } }, required: [], additionalProperties: false },
  },
  {
    name: 'create_order_draft',
    description:
      'Prepare an order for the shop to confirm. Call only after the customer clearly wants these exact items AND gave first name, last name and phone, AND the city and branch were found with find_np_city/find_np_branch in this turn, AND the customer chose a payment method from get_checkout_options. The result says whether the order is still waiting for the shop or was confirmed.',
    parameters: {
      type: 'object',
      properties: {
        items: itemsSchema,
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        phone: { type: 'string', description: 'Ukrainian phone number as the customer wrote it' },
        cityRef: { type: 'string', description: 'cityRef from find_np_city' },
        branchRef: { type: 'string', description: 'branchRef from find_np_branch' },
        paymentMethod: { type: 'string', enum: ['cod', 'prepaid'] },
        note: { type: 'string' },
      },
      required: ['items', 'firstName', 'lastName', 'phone', 'cityRef', 'branchRef', 'paymentMethod'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_order_status',
    description: "Status of this customer's orders in this conversation: confirmation, Nova Poshta TTN and delivery status. Call before saying anything about an order's state or delivery.",
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'escalate',
    description: 'Hand the conversation to a human manager (unknown facts, discounts, returns, complaints, payment, anything sensitive or unclear). After this you may still send one short holding message to the customer.',
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Short reason for the manager, in the shop language' } }, required: ['reason'], additionalProperties: false },
  },
];

const productView = (pw: ProductWithVariants, facts: RunFacts) => ({
  name: pw.product.name,
  description: pw.product.description.slice(0, 300),
  variants: pw.variants
    .filter((v) => v.active)
    .map((v) => {
      const price = effectivePrice(pw.product, v);
      facts.prices.add(price);
      facts.stocks.add(v.stock);
      return { sku: v.sku, options: v.options, price: formatMoney(price, pw.product.currency), priceMinor: price, inStock: v.stock > 0, stock: v.stock };
    }),
});

const quoteView = (q: OrderQuote, facts: RunFacts) => {
  facts.prices.add(q.totalMinor);
  for (const l of q.lines) {
    facts.prices.add(l.unitPriceMinor);
    facts.prices.add(l.lineTotalMinor);
    facts.quantities.add(l.quantity);
    if (l.stock >= 0) facts.stocks.add(l.stock);
  }
  return {
    currency: q.currency,
    total: formatMoney(q.totalMinor, q.currency),
    lines: q.lines.map((l) => ({ sku: l.sku, name: l.productName, options: l.options, quantity: l.quantity, unitPrice: formatMoney(l.unitPriceMinor, q.currency), lineTotal: formatMoney(l.lineTotalMinor, q.currency) })),
  };
};

const PRICE_IN_TEXT = /(\d{1,3}(?:[\s\u00a0]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:грн\.?|гривень|гривні|гривня|₴|uah)/giu;

const STATUS_LABEL: Record<string, string> = {
  pending_approval: 'waiting for the shop to confirm',
  approved: 'confirmed by the shop',
  awaiting_payment: 'confirmed, waiting for payment',
  cod_confirmed: 'confirmed, cash on delivery, being prepared for Nova Poshta',
  paid: 'paid',
  shipped: 'handed to Nova Poshta',
  delivered: 'received by the customer',
  returning: 'parcel is on its way back to the shop',
  returned: 'parcel returned to the shop',
  rejected: 'declined by the shop',
  cancelled: 'cancelled',
  refund_requested: 'refund requested',
};

const orderView = ({ draft: d }: OrderDraft, facts: RunFacts) => {
  facts.prices.add(d.totalMinor);
  if (d.ttn) facts.ttns.add(d.ttn);
  return {
    orderId: d.id.slice(0, 8),
    status: d.status,
    meaning: STATUS_LABEL[d.status] ?? d.status,
    total: formatMoney(d.totalMinor, d.currency),
    paymentMethod: d.paymentMethod,
    novaPoshta: d.ttn ? { ttn: d.ttn, status: d.npStatusText || null, statusAt: d.npStatusAt } : null,
    branch: d.npCityName && d.npWarehouseName ? `${d.npCityName}, ${d.npWarehouseName}` : null,
    createdAt: d.createdAt,
  };
};

const npUnavailable = { error: 'Nova Poshta lookup is not available for this shop right now. Do not guess the branch: call escalate.' };

/** Runs one tool call. Never throws: a bad call becomes an `{error}` result the model can react to. */
export async function runTool(ctx: ToolContext, name: string, rawArgs: string): Promise<string> {
  const out = (v: unknown) => JSON.stringify(v);
  let json: unknown;
  try {
    json = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return out({ error: 'arguments are not valid JSON' });
  }
  const bad = (e: z.ZodError) => out({ error: `invalid arguments: ${e.issues.map((i) => `${i.path.join('.') || 'args'} ${i.message}`).join('; ')}` });
  try {
    switch (name) {
      case 'search_products': {
        const a = searchArgs.safeParse(json);
        if (!a.success) return bad(a.error);
        ctx.facts.productLookups++;
        let found = ctx.catalog.listProducts(ctx.shopId, { q: a.data.query, active: true, limit: a.data.limit });
        // The catalog ANDs every word; a customer-style query ("худі Classic чорне") would then match nothing. Fall back to products matching any word, best match first.
        const words = [...new Set(a.data.query.toLowerCase().split(/\s+/).filter((w) => w.length > 1))].slice(0, 6);
        if (!found.items.length && words.length > 1) {
          const hits = new Map<string, { pw: ProductWithVariants; n: number }>();
          for (const w of words)
            for (const pw of ctx.catalog.listProducts(ctx.shopId, { q: w, active: true, limit: 20 }).items) hits.set(pw.product.id, { pw, n: (hits.get(pw.product.id)?.n ?? 0) + 1 });
          const items = [...hits.values()].sort((x, y) => y.n - x.n).slice(0, a.data.limit).map((h) => h.pw);
          found = { items, total: hits.size };
        }
        const products = found.items.map((p) => productView(p, ctx.facts)).filter((p) => p.variants.length);
        return out({ total: found.total, products });
      }
      case 'get_variant': {
        const a = skuArgs.safeParse(json);
        if (!a.success) return bad(a.error);
        const v = ctx.catalog.findVariantBySku(ctx.shopId, a.data.sku);
        if (!v || !v.active || !v.product.active) return out({ error: 'no such active SKU' });
        ctx.facts.productLookups++;
        const { variants, ...p } = productView({ product: v.product, variants: [v] }, ctx.facts);
        return out({ ...p, variant: variants[0] });
      }
      case 'quote_order': {
        const a = quoteArgs.safeParse(json);
        if (!a.success) return bad(a.error);
        ctx.facts.productLookups++;
        return out(quoteView(ctx.orders.quote(ctx.shopId, a.data.items), ctx.facts));
      }
      case 'get_policy': {
        const a = policyArgs.safeParse(json);
        if (!a.success) return bad(a.error);
        const p = ctx.policies.get(ctx.shopId, a.data.topic);
        ctx.facts.policies.set(a.data.topic, p?.text ?? null);
        if (!p) return out({ topic: a.data.topic, available: false, instruction: 'The shop has no text on this. Do not answer from general knowledge: call escalate.' });
        for (const n of p.text.match(/\d+/g) ?? []) ctx.facts.policyNumbers.add(Number(n));
        for (const m of p.text.matchAll(PRICE_IN_TEXT)) ctx.facts.prices.add(Math.round(Number.parseFloat(m[1]!.replace(/[\s\u00a0]/g, '').replace(',', '.')) * 100));
        return out({ topic: a.data.topic, available: true, version: p.version, text: p.text });
      }
      case 'find_np_city': {
        const a = cityArgs.safeParse(json);
        if (!a.success) return bad(a.error);
        if (!ctx.delivery?.connected(ctx.shopId)) return out(npUnavailable);
        const cities = await ctx.delivery.cities(ctx.shopId, a.data.query);
        for (const c of cities) ctx.facts.npCities.set(c.ref, c.name);
        return out({ cities: cities.map((c) => ({ cityRef: c.ref, name: c.name, area: c.area })), ...(cities.length ? {} : { note: 'No such city at Nova Poshta. Ask the customer to check the spelling.' }) });
      }
      case 'find_np_branch': {
        const a = branchArgs.safeParse(json);
        if (!a.success) return bad(a.error);
        if (!ctx.facts.npCities.has(a.data.cityRef)) return out({ error: 'unknown cityRef: call find_np_city in this turn first' });
        if (!ctx.delivery?.connected(ctx.shopId)) return out(npUnavailable);
        const list = await ctx.delivery.warehouses(ctx.shopId, a.data.cityRef, a.data.query);
        for (const w of list) ctx.facts.npBranches.set(w.ref, { cityRef: a.data.cityRef, name: w.name });
        return out({ branches: list.map((w) => ({ branchRef: w.ref, number: w.number, name: w.name })), ...(list.length ? {} : { note: 'No matching working branch. Ask for another branch number or street.' }) });
      }
      case 'get_checkout_options': {
        const a = checkoutArgs.safeParse(json);
        if (!a.success) return bad(a.error);
        const phone = a.data.phone ? normalizeUaPhone(a.data.phone) : null;
        const pm = ctx.deliveryRepo.paymentMethods(ctx.shopId, { phone, customerId: ctx.customerId });
        ctx.facts.paymentMethods = pm.methods;
        const labels: Record<PaymentMethod, string> = { cod: 'cash on delivery at the Nova Poshta branch (накладений платіж)', prepaid: 'prepayment; the shop sends payment details after confirming' };
        return out({
          paymentMethods: pm.methods.map((m) => ({ method: m, description: labels[m] })),
          ...(a.data.phone && !phone ? { phoneProblem: 'not a valid Ukrainian phone number; ask the customer to check it' } : {}),
          ...(pm.methods.length ? {} : { note: 'No payment method is available for this customer. Do not offer any: call escalate.' }),
        });
      }
      case 'create_order_draft': {
        const a = draftArgs.safeParse(json);
        if (!a.success) return bad(a.error);
        ctx.facts.productLookups++;
        const city = ctx.facts.npCities.get(a.data.cityRef);
        const branch = ctx.facts.npBranches.get(a.data.branchRef);
        if (!city || !branch || branch.cityRef !== a.data.cityRef) return out({ error: 'cityRef/branchRef were not returned by find_np_city/find_np_branch in this turn: look them up first' });
        const { items: lineItems, firstName, lastName, phone, paymentMethod, note } = a.data;
        const created = ctx.orders.createDraft(ctx.shopId, {
          items: lineItems,
          note,
          conversationId: ctx.conversationId,
          createdBy: 'ai',
          runId: ctx.runId,
          checkout: { firstName, lastName, phone, paymentMethod, npCityRef: a.data.cityRef, npCityName: city, npWarehouseRef: a.data.branchRef, npWarehouseName: branch.name },
        });
        const { draft, items: lines } = created;
        ctx.facts.draftId = draft.id;
        const settings = ctx.agent.getSettings(ctx.shopId);
        const auto = settings.autonomy === 'auto_confirm' ? ctx.orders.autoConfirm(ctx.shopId, draft.id, { maxTotalMinor: settings.autoConfirmMaxMinor }) : null;
        if (auto?.approved) {
          ctx.delivery?.afterApproval(ctx.shopId, auto.draft);
          ctx.notify?.notify({ kind: 'order_update', shopId: ctx.shopId, conversationId: ctx.conversationId, draftId: draft.id, event: 'auto_confirmed', ttn: null });
        } else ctx.notify?.notify({ kind: 'order_draft', shopId: ctx.shopId, conversationId: ctx.conversationId, draftId: draft.id, currency: draft.currency, totalMinor: draft.totalMinor, itemCount: lines.length });
        const q: OrderQuote = {
          currency: draft.currency,
          totalMinor: draft.totalMinor,
          lines: lines.map((l) => ({ ...l, lineTotalMinor: l.unitPriceMinor * l.quantity, stock: -1 })),
        };
        const view = quoteView(q, ctx.facts);
        if (auto?.approved)
          return out({ draftId: draft.id, status: auto.draft.draft.status, confirmed: true, note: 'The shop confirmed this order automatically. You may say it is confirmed and will be sent by Nova Poshta. Do not promise a delivery date.', ...view });
        return out({ draftId: draft.id, status: 'pending_approval', confirmed: false, note: 'NOT a confirmed order. The shop must confirm it first; tell the customer exactly that.', ...view });
      }
      case 'get_order_status': {
        const a = noArgs.safeParse(json);
        if (!a.success) return bad(a.error);
        ctx.facts.orderStatusLookups++;
        const list = ctx.orders.listDrafts(ctx.shopId, { conversationId: ctx.conversationId, limit: 3 }).items;
        return out({ orders: list.map((d) => orderView(d, ctx.facts)), ...(list.length ? {} : { note: 'This customer has no orders in this conversation.' }) });
      }
      case 'escalate': {
        const a = escalateArgs.safeParse(json);
        if (!a.success) return bad(a.error);
        const e = ctx.agent.escalate(ctx.shopId, ctx.conversationId, a.data.reason, ctx.runId);
        if (e.created) ctx.notify?.notify({ kind: 'escalation', shopId: ctx.shopId, conversationId: ctx.conversationId, reason: a.data.reason });
        ctx.facts.escalatedReason = a.data.reason;
        return out({ ok: true, note: 'A manager will take over. Do not promise a time.' });
      }
      default:
        return out({ error: `unknown tool ${name}` });
    }
  } catch (e) {
    if (e instanceof OrderValidationError) return out({ error: e.issues });
    if (e instanceof ConnectorError) return out(npUnavailable);
    return out({ error: 'tool failed' });
  }
}
