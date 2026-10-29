import { z } from 'zod';
import {
  OrderValidationError,
  type AgentRepository,
  type CatalogRepository,
  type OrderQuote,
  type OrderRepository,
  type ProductWithVariants,
  effectivePrice,
} from '@hepson/database';
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
}

export type ToolContext = {
  shopId: string;
  conversationId: string;
  runId: string;
  catalog: CatalogRepository;
  orders: OrderRepository;
  agent: AgentRepository;
  facts: RunFacts;
  notify?: Notifier;
};

const items = z.array(z.strictObject({ sku: z.string().trim().min(1).max(64), quantity: z.number().int().min(1).max(1000) })).min(1).max(20);
const searchArgs = z.strictObject({ query: z.string().trim().max(200).default(''), limit: z.number().int().min(1).max(5).default(5) });
const skuArgs = z.strictObject({ sku: z.string().trim().min(1).max(64) });
const quoteArgs = z.strictObject({ items });
const escalateArgs = z.strictObject({ reason: z.string().trim().min(1).max(500) });
const draftArgs = z.strictObject({
  items,
  contactName: z.string().trim().min(1).max(200),
  contactPhone: z.string().trim().min(5).max(40),
  deliveryInfo: z.string().trim().min(1).max(500),
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
    name: 'create_order_draft',
    description:
      'Prepare an order DRAFT for a human manager to approve. Call only after the customer clearly wants these exact items AND has given name, phone and delivery info. A draft is NOT a confirmed order: nothing is reserved, paid or shipped until a manager approves.',
    parameters: {
      type: 'object',
      properties: {
        items: itemsSchema,
        contactName: { type: 'string' },
        contactPhone: { type: 'string' },
        deliveryInfo: { type: 'string', description: 'City and delivery service/branch or address, as the customer wrote it' },
        note: { type: 'string' },
      },
      required: ['items', 'contactName', 'contactPhone', 'deliveryInfo'],
      additionalProperties: false,
    },
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

/** Runs one tool call. Never throws: a bad call becomes an `{error}` result the model can react to. */
export function runTool(ctx: ToolContext, name: string, rawArgs: string): string {
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
      case 'create_order_draft': {
        const a = draftArgs.safeParse(json);
        if (!a.success) return bad(a.error);
        ctx.facts.productLookups++;
        const { draft, items: lines } = ctx.orders.createDraft(ctx.shopId, { ...a.data, conversationId: ctx.conversationId, createdBy: 'ai', runId: ctx.runId });
        ctx.facts.draftId = draft.id;
        ctx.notify?.notify({ kind: 'order_draft', shopId: ctx.shopId, conversationId: ctx.conversationId, draftId: draft.id, currency: draft.currency, totalMinor: draft.totalMinor, itemCount: lines.length });
        const q: OrderQuote = {
          currency: draft.currency,
          totalMinor: draft.totalMinor,
          lines: lines.map((l) => ({ ...l, lineTotalMinor: l.unitPriceMinor * l.quantity, stock: -1 })),
        };
        const view = quoteView(q, ctx.facts);
        return out({ draftId: draft.id, status: 'pending_approval', confirmed: false, note: 'NOT a confirmed order. A manager must approve it first; tell the customer exactly that.', ...view });
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
    return out({ error: 'tool failed' });
  }
}
