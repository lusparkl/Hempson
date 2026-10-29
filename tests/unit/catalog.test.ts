import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogNotFoundError, CatalogRepository, CatalogValidationError, InsufficientStockError, ShopRepository, SkuTakenError, openDb, runMigrations, type DbHandle } from '@hepson/database';

let h: DbHandle;
let c: CatalogRepository;
let A: string;
let B: string;
beforeEach(() => {
  h = openDb(':memory:');
  runMigrations(h);
  const shops = new ShopRepository(h);
  A = shops.create({ name: 'A', slug: 'aa' }).id;
  B = shops.create({ name: 'B', slug: 'bb' }).id;
  c = new CatalogRepository(h);
});
afterEach(() => h.close());

const base = { name: 'Футболка', priceMinor: 49900, currency: 'UAH' };

describe('products and variants', () => {
  it('creates a default variant when none given; SKU uppercased', () => {
    const p = c.createProduct(A, { ...base, sku: 'tee-1', stock: 5 });
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0]).toMatchObject({ sku: 'TEE-1', options: {}, stock: 5, priceMinor: null, active: true });
    expect(p.product).toMatchObject({ active: true, description: '', media: [] });
  });

  it('creates explicit variants with price override', () => {
    const p = c.createProduct(A, { ...base, variants: [{ sku: 'T-S', options: { size: 'S' }, stock: 2 }, { sku: 'T-L', options: { size: 'L' }, priceMinor: 55000 }] });
    expect(p.variants.map((v) => v.sku)).toEqual(['T-S', 'T-L']);
    expect(p.variants[1]!.priceMinor).toBe(55000);
  });

  it.each<[unknown, string]>([
    [{ ...base }, 'sku required without variants'],
    [{ ...base, sku: 'x', variants: [{ sku: 'y' }] }, 'sku with variants'],
    [{ ...base, sku: 'x', priceMinor: -1 }, 'negative price'],
    [{ ...base, sku: 'x', priceMinor: 1.5 }, 'fractional price'],
    [{ ...base, sku: 'x', stock: -1 }, 'negative stock'],
    [{ ...base, sku: 'x', currency: 'uah' }, 'bad currency'],
    [{ ...base, sku: 'bad sku!' }, 'bad sku'],
    [{ ...base, name: '  ', sku: 'x' }, 'blank name'],
    [{ ...base, sku: 'x', variants: [] }, 'empty variants'],
    [{ ...base, sku: 'x', extra: 1 }, 'unknown key'],
  ])('rejects invalid create (%#: %s)', (input) => {
    expect(() => c.createProduct(A, input as never)).toThrow(CatalogValidationError);
    expect(c.listProducts(A).total).toBe(0);
  });

  it('SKU unique per shop (case-insensitive), reusable across shops; failed create leaves nothing', () => {
    c.createProduct(A, { ...base, sku: 'dup' });
    expect(() => c.createProduct(A, { ...base, sku: 'DUP' })).toThrow(SkuTakenError);
    expect(() => c.createProduct(A, { ...base, variants: [{ sku: 'new1' }, { sku: 'dup' }] })).toThrow(SkuTakenError);
    expect(c.listProducts(A).total).toBe(1);
    expect(c.findVariantBySku(A, 'new1')).toBeUndefined();
    expect(() => c.createProduct(B, { ...base, sku: 'dup' })).not.toThrow();
  });

  it('updates product; rejects empty/invalid/unknown id', () => {
    const p = c.createProduct(A, { ...base, sku: 'x1' });
    const u = c.updateProduct(A, p.product.id, { name: 'Нова', active: false, priceMinor: 100 });
    expect(u.product).toMatchObject({ name: 'Нова', active: false, priceMinor: 100 });
    expect(() => c.updateProduct(A, p.product.id, {})).toThrow(CatalogValidationError);
    expect(() => c.updateProduct(A, p.product.id, { priceMinor: -5 })).toThrow(CatalogValidationError);
    expect(() => c.updateProduct(A, crypto.randomUUID(), { name: 'x' })).toThrow(CatalogNotFoundError);
  });

  it('adds and updates variants; SKU clash on update', () => {
    const p = c.createProduct(A, { ...base, sku: 'a1' });
    const v = c.addVariant(A, p.product.id, { sku: 'a2', options: { color: 'red' }, stock: 3 });
    expect(() => c.addVariant(A, p.product.id, { sku: 'A1' })).toThrow(SkuTakenError);
    expect(() => c.updateVariant(A, p.product.id, v.id, { sku: 'a1' })).toThrow(SkuTakenError);
    expect(c.updateVariant(A, p.product.id, v.id, { priceMinor: 777, active: false })).toMatchObject({ priceMinor: 777, active: false, sku: 'A2', stock: 3 });
    expect(c.updateVariant(A, p.product.id, v.id, { priceMinor: null }).priceMinor).toBeNull();
  });
});

describe('stock', () => {
  it('adjusts atomically and never below zero', () => {
    const p = c.createProduct(A, { ...base, sku: 's1', stock: 3 });
    const vid = p.variants[0]!.id;
    expect(c.adjustStock(A, p.product.id, vid, -2).stock).toBe(1);
    expect(() => c.adjustStock(A, p.product.id, vid, -2)).toThrow(InsufficientStockError);
    expect(c.getProduct(A, p.product.id)!.variants[0]!.stock).toBe(1);
    expect(c.adjustStock(A, p.product.id, vid, 10).stock).toBe(11);
    expect(() => c.adjustStock(A, p.product.id, vid, 1.5)).toThrow(CatalogValidationError);
    expect(() => c.adjustStock(A, p.product.id, crypto.randomUUID(), 1)).toThrow(CatalogNotFoundError);
  });

  it('DB rejects negative stock even if the service were bypassed', () => {
    const p = c.createProduct(A, { ...base, sku: 's1', stock: 1 });
    expect(() => h.raw.prepare('update product_variants set stock = -1 where id = ?').run(p.variants[0]!.id)).toThrow(/CHECK/);
  });
});

describe('search', () => {
  beforeEach(() => {
    c.createProduct(A, { name: 'Червона Сукня', description: 'Літня, бавовна', priceMinor: 100, currency: 'UAH', variants: [{ sku: 'DR-1', options: { size: 'M', color: 'Червоний' } }] });
    c.createProduct(A, { name: 'Кросівки', priceMinor: 200, currency: 'UAH', sku: 'SH-1', active: false });
    c.createProduct(B, { name: 'Сукня чужа', priceMinor: 100, currency: 'UAH', sku: 'OTHER-1' });
  });
  it('matches Cyrillic case-insensitively across name, description, sku, options', () => {
    expect(c.listProducts(A, { q: 'СУКНЯ' }).total).toBe(1);
    expect(c.listProducts(A, { q: 'бавовна' }).total).toBe(1);
    expect(c.listProducts(A, { q: 'dr-1' }).total).toBe(1);
    expect(c.listProducts(A, { q: 'червоний m' }).total).toBe(1);
    expect(c.listProducts(A, { q: 'сукня кросівки' }).total).toBe(0);
  });
  it('is shop-scoped and escapes LIKE wildcards', () => {
    expect(c.listProducts(A, { q: 'чужа' }).total).toBe(0);
    expect(c.listProducts(A, { q: '%' }).total).toBe(0);
    expect(c.listProducts(A, { q: '_' }).total).toBe(0);
  });
  it('filters by active and paginates', () => {
    expect(c.listProducts(A, { active: false }).items.map((i) => i.product.name)).toEqual(['Кросівки']);
    const page = c.listProducts(A, { limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
  });
  it('reindexes after edits', () => {
    const id = c.listProducts(A, { q: 'сукня' }).items[0]!.product.id;
    c.updateProduct(A, id, { name: 'Спідниця' });
    expect(c.listProducts(A, { q: 'сукня' }).total).toBe(0);
    expect(c.listProducts(A, { q: 'спідниця' }).total).toBe(1);
  });
});

describe('tenant isolation', () => {
  it('ids from another shop are not found / not mutable', () => {
    const p = c.createProduct(A, { ...base, sku: 'iso-1', stock: 4 });
    const vid = p.variants[0]!.id;
    expect(c.getProduct(B, p.product.id)).toBeUndefined();
    expect(c.findVariantBySku(B, 'iso-1')).toBeUndefined();
    expect(() => c.updateProduct(B, p.product.id, { name: 'x' })).toThrow(CatalogNotFoundError);
    expect(() => c.addVariant(B, p.product.id, { sku: 'zz' })).toThrow(CatalogNotFoundError);
    expect(() => c.updateVariant(B, p.product.id, vid, { active: false })).toThrow(CatalogNotFoundError);
    expect(() => c.adjustStock(B, p.product.id, vid, -1)).toThrow(CatalogNotFoundError);
    expect(c.getProduct(A, p.product.id)!.variants[0]).toMatchObject({ stock: 4, active: true });
  });
});
