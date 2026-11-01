import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import * as t from './schema';

export type ProductRow = typeof t.products.$inferSelect;
export type VariantRow = typeof t.productVariants.$inferSelect;
export type ProductWithVariants = { product: ProductRow; variants: VariantRow[] };

export class CatalogValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid catalog input: ${issues.join('; ')}`);
    this.name = 'CatalogValidationError';
  }
}
export class SkuTakenError extends Error {
  constructor(readonly sku: string) {
    super(`SKU already in use in this shop: ${sku}`);
    this.name = 'SkuTakenError';
  }
}
export class CatalogNotFoundError extends Error {
  constructor(what: 'product' | 'variant') {
    super(`${what} not found`);
    this.name = 'CatalogNotFoundError';
  }
}
export class InsufficientStockError extends Error {
  constructor() {
    super('stock cannot go below zero');
    this.name = 'InsufficientStockError';
  }
}

const MAX_MINOR = 10_000_000_000;
const priceMinor = z.number().int().min(0).max(MAX_MINOR);
const stock = z.number().int().min(0).max(1_000_000_000);
const sku = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, '1-64 chars: letters, digits, . _ -')
  .transform((s) => s.toUpperCase());
const options = z.record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(60)).refine((o) => Object.keys(o).length <= 10, 'at most 10 options');
const media = z.array(z.string().trim().min(1).max(2048)).max(20);
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. UAH');

const variantInput = z.strictObject({ sku, options: options.default({}), priceMinor: priceMinor.nullable().optional(), stock: stock.default(0), active: z.boolean().default(true) });
const variantPatch = z
  .strictObject({ sku, options, priceMinor: priceMinor.nullable(), stock, active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'no fields to update');

const productFields = { name: z.string().trim().min(1).max(200), description: z.string().max(5000), priceMinor, currency, active: z.boolean(), media };
/** Without `variants`, one default variant (options {}) is created from `sku` / `stock`. */
const createProduct = z
  .strictObject({
    ...productFields,
    description: productFields.description.default(''),
    active: productFields.active.default(true),
    media: productFields.media.default([]),
    sku: sku.optional(),
    stock: stock.default(0),
    variants: z.array(variantInput).min(1).max(200).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.variants && (v.sku !== undefined || v.stock !== 0)) ctx.addIssue({ code: 'custom', message: 'sku/stock apply only to the default variant; omit them when sending variants' });
    if (!v.variants && !v.sku) ctx.addIssue({ code: 'custom', path: ['sku'], message: 'sku is required when no variants are given' });
  });
const updateProduct = z
  .strictObject(productFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'no fields to update');

export type CreateProductInput = z.input<typeof createProduct>;
export type UpdateProductInput = z.input<typeof updateProduct>;
export type CreateVariantInput = z.input<typeof variantInput>;
export type UpdateVariantInput = z.input<typeof variantPatch>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new CatalogValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
  return r.data;
}
const isUnique = (e: unknown) => (e as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE';
/** Effective price: variant override, else product price. */
export const effectivePrice = (p: ProductRow, v: VariantRow) => v.priceMinor ?? p.priceMinor;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Shop-scoped catalog access. Every method takes `shopId` first and filters by it, including
 * lookups by id, so an id from another shop is simply "not found".
 */
export class CatalogRepository {
  readonly db: Db;
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }
  private now() {
    return this.clock().toISOString();
  }

  /** Runs `fn` atomically; nested calls become savepoints, so an inner throw undoes only the inner work. */
  transaction<T>(fn: () => T): T {
    return this.handle.raw.transaction(fn)();
  }

  private variantsOf(shopId: string, productIds: string[]): VariantRow[] {
    if (!productIds.length) return [];
    return this.db
      .select()
      .from(t.productVariants)
      .where(and(eq(t.productVariants.shopId, shopId), inArray(t.productVariants.productId, productIds)))
      .orderBy(asc(t.productVariants.createdAt), asc(t.productVariants.sku))
      .all();
  }

  private reindex(shopId: string, productId: string): void {
    const p = this.db.select().from(t.products).where(and(eq(t.products.shopId, shopId), eq(t.products.id, productId))).get();
    if (!p) return;
    const vs = this.variantsOf(shopId, [productId]);
    const text = [p.name, p.description, ...vs.flatMap((v) => [v.sku, ...Object.values(v.options)])].join(' ').toLowerCase();
    this.db.update(t.products).set({ searchText: text }).where(eq(t.products.id, productId)).run();
  }

  private insertVariant(shopId: string, productId: string, v: z.output<typeof variantInput>): VariantRow {
    const ts = this.now();
    const row: VariantRow = { id: randomUUID(), shopId, productId, sku: v.sku, options: v.options, priceMinor: v.priceMinor ?? null, stock: v.stock, active: v.active, createdAt: ts, updatedAt: ts };
    try {
      this.db.insert(t.productVariants).values(row).run();
    } catch (e) {
      if (isUnique(e)) throw new SkuTakenError(v.sku);
      throw e;
    }
    return row;
  }

  createProduct(shopId: string, input: CreateProductInput): ProductWithVariants {
    const v = parse(createProduct, input);
    return this.handle.raw.transaction(() => {
      const ts = this.now();
      const product: ProductRow = {
        id: randomUUID(),
        shopId,
        name: v.name,
        description: v.description,
        priceMinor: v.priceMinor,
        currency: v.currency,
        active: v.active,
        media: v.media,
        searchText: '',
        createdAt: ts,
        updatedAt: ts,
      };
      this.db.insert(t.products).values(product).run();
      const inputs = v.variants ?? [{ sku: v.sku!, options: {}, priceMinor: null, stock: v.stock, active: true }];
      const variants = inputs.map((x) => this.insertVariant(shopId, product.id, x));
      this.reindex(shopId, product.id);
      return { product: this.getProduct(shopId, product.id)!.product, variants };
    })();
  }

  getProduct(shopId: string, productId: string): ProductWithVariants | undefined {
    const product = this.db.select().from(t.products).where(and(eq(t.products.shopId, shopId), eq(t.products.id, productId))).get();
    return product && { product, variants: this.variantsOf(shopId, [productId]) };
  }

  findVariantBySku(shopId: string, skuValue: string): (VariantRow & { product: ProductRow }) | undefined {
    const s = sku.safeParse(skuValue);
    if (!s.success) return undefined;
    const v = this.db.select().from(t.productVariants).where(and(eq(t.productVariants.shopId, shopId), eq(t.productVariants.sku, s.data))).get();
    const product = v && this.db.select().from(t.products).where(eq(t.products.id, v.productId)).get();
    return v && product ? { ...v, product } : undefined;
  }

  /** `q`: whitespace-separated tokens, all must match (case-insensitive, incl. Cyrillic) in name, description, SKU or option values. */
  listProducts(shopId: string, f: { q?: string; active?: boolean; limit?: number; offset?: number } = {}): { items: ProductWithVariants[]; total: number } {
    const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(f.offset ?? 0), 0);
    const conds = [eq(t.products.shopId, shopId)];
    if (f.active !== undefined) conds.push(eq(t.products.active, f.active));
    for (const tok of (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) conds.push(sql`${t.products.searchText} like ${`%${likeEscape(tok)}%`} escape '\\'`);
    const where = and(...conds);
    const total = this.db.select({ n: sql<number>`count(*)` }).from(t.products).where(where).get()!.n;
    const rows = this.db.select().from(t.products).where(where).orderBy(desc(t.products.createdAt), asc(t.products.name)).limit(limit).offset(offset).all();
    const vs = this.variantsOf(shopId, rows.map((r) => r.id));
    return { total, items: rows.map((product) => ({ product, variants: vs.filter((v) => v.productId === product.id) })) };
  }

  private withStock(shopId: string, rows: ProductRow[]): ProductWithVariants[] {
    const vs = this.variantsOf(shopId, rows.map((r) => r.id));
    return rows
      .map((product) => ({ product, variants: vs.filter((v) => v.productId === product.id && v.active && v.stock > 0) }))
      .filter((pw) => pw.product.active && pw.variants.length);
  }

  /**
   * Other active, in-stock products sharing at least one name word with `productId` (P9 alternatives). Ranked by the number
   * of shared words, then by price closeness. No shared word means no suggestion: unrelated products are never offered.
   */
  similarProducts(shopId: string, productId: string, limit = 3): ProductWithVariants[] {
    const src = this.db.select().from(t.products).where(and(eq(t.products.shopId, shopId), eq(t.products.id, productId))).get();
    if (!src) return [];
    const words = [...new Set(src.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))].slice(0, 6);
    const hits = new Map<string, { p: ProductRow; n: number }>();
    for (const w of words) {
      const rows = this.db
        .select()
        .from(t.products)
        .where(and(eq(t.products.shopId, shopId), eq(t.products.active, true), sql`${t.products.id} <> ${productId}`, sql`${t.products.searchText} like ${`%${likeEscape(w)}%`} escape '\\'`))
        .limit(50)
        .all();
      for (const p of rows) hits.set(p.id, { p, n: (hits.get(p.id)?.n ?? 0) + 1 });
    }
    const ranked = [...hits.values()].sort((x, y) => y.n - x.n || Math.abs(x.p.priceMinor - src.priceMinor) - Math.abs(y.p.priceMinor - src.priceMinor));
    return this.withStock(
      shopId,
      ranked.map((h) => h.p),
    ).slice(0, limit);
  }

  /**
   * Active, in-stock products that appeared in the same order drafts as `productId` (P9 complements), most shared drafts
   * first. Rejected and cancelled drafts (including superseded ones) do not count.
   */
  boughtTogether(shopId: string, productId: string, limit = 3): ProductWithVariants[] {
    const other = alias(t.orderDraftItems, 'other');
    const n = sql<number>`count(distinct ${other.draftId})`;
    const rows = this.db
      .select({ productId: other.productId, n })
      .from(t.orderDraftItems)
      .innerJoin(other, and(eq(other.draftId, t.orderDraftItems.draftId), sql`${other.productId} <> ${t.orderDraftItems.productId}`))
      .innerJoin(t.orderDrafts, eq(t.orderDrafts.id, t.orderDraftItems.draftId))
      .where(and(eq(t.orderDraftItems.shopId, shopId), eq(t.orderDraftItems.productId, productId), eq(t.orderDrafts.shopId, shopId), notInArray(t.orderDrafts.status, ['rejected', 'cancelled'])))
      .groupBy(other.productId)
      .orderBy(desc(n), asc(other.productId))
      .limit(20)
      .all();
    if (!rows.length) return [];
    const products = this.db
      .select()
      .from(t.products)
      .where(and(eq(t.products.shopId, shopId), inArray(t.products.id, rows.map((r) => r.productId))))
      .all();
    const byId = new Map(products.map((p) => [p.id, p]));
    return this.withStock(
      shopId,
      rows.map((r) => byId.get(r.productId)).filter((p): p is ProductRow => !!p),
    ).slice(0, limit);
  }

  updateProduct(shopId: string, productId: string, input: UpdateProductInput): ProductWithVariants {
    const v = parse(updateProduct, input);
    return this.handle.raw.transaction(() => {
      const r = this.db.update(t.products).set({ ...v, updatedAt: this.now() }).where(and(eq(t.products.shopId, shopId), eq(t.products.id, productId))).returning().get();
      if (!r) throw new CatalogNotFoundError('product');
      this.reindex(shopId, productId);
      return this.getProduct(shopId, productId)!;
    })();
  }

  addVariant(shopId: string, productId: string, input: CreateVariantInput): VariantRow {
    const v = parse(variantInput, input);
    return this.handle.raw.transaction(() => {
      if (!this.getProduct(shopId, productId)) throw new CatalogNotFoundError('product');
      const row = this.insertVariant(shopId, productId, v);
      this.reindex(shopId, productId);
      return row;
    })();
  }

  updateVariant(shopId: string, productId: string, variantId: string, input: UpdateVariantInput): VariantRow {
    const v = parse(variantPatch, input);
    return this.handle.raw.transaction(() => {
      try {
        const r = this.db
          .update(t.productVariants)
          .set({ ...v, updatedAt: this.now() })
          .where(and(eq(t.productVariants.shopId, shopId), eq(t.productVariants.productId, productId), eq(t.productVariants.id, variantId)))
          .returning()
          .get();
        if (!r) throw new CatalogNotFoundError('variant');
        this.reindex(shopId, productId);
        return r;
      } catch (e) {
        if (isUnique(e)) throw new SkuTakenError(v.sku ?? '');
        throw e;
      }
    })();
  }

  /** Atomic relative change; fails (no change) if the result would be negative. */
  adjustStock(shopId: string, productId: string, variantId: string, delta: number): VariantRow {
    if (!Number.isInteger(delta) || Math.abs(delta) > 1_000_000_000) throw new CatalogValidationError(['delta: must be an integer']);
    const r = this.db
      .update(t.productVariants)
      .set({ stock: sql`${t.productVariants.stock} + ${delta}`, updatedAt: this.now() })
      .where(
        and(
          eq(t.productVariants.shopId, shopId),
          eq(t.productVariants.productId, productId),
          eq(t.productVariants.id, variantId),
          sql`${t.productVariants.stock} + ${delta} >= 0`,
        ),
      )
      .returning()
      .get();
    if (r) return r;
    const exists = this.db
      .select({ id: t.productVariants.id })
      .from(t.productVariants)
      .where(and(eq(t.productVariants.shopId, shopId), eq(t.productVariants.productId, productId), eq(t.productVariants.id, variantId)))
      .get();
    throw exists ? new InsufficientStockError() : new CatalogNotFoundError('variant');
  }
}
