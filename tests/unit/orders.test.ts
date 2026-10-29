import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthRepository,
  CatalogRepository,
  ConversationRepository,
  OrderNotFoundError,
  OrderRepository,
  OrderStateError,
  OrderStockError,
  OrderValidationError,
  ShopRepository,
  openDb,
  runMigrations,
  type DbHandle,
} from '@hepson/database';

let h: DbHandle;
let orders: OrderRepository;
let catalog: CatalogRepository;
let conv: ConversationRepository;
let A: string;
let B: string;
let user: string;
let convA: string;

beforeEach(() => {
  h = openDb(':memory:');
  runMigrations(h);
  const shops = new ShopRepository(h);
  A = shops.create({ name: 'A', slug: 'aa' }).id;
  B = shops.create({ name: 'B', slug: 'bb' }).id;
  const auth = new AuthRepository(h);
  user = auth.createUser({ email: 'u@example.com', displayName: 'U' }, 'hash').id;
  auth.addMember(A, user, 'owner');
  catalog = new CatalogRepository(h);
  conv = new ConversationRepository(h);
  orders = new OrderRepository(h);
  convA = conv.ensureConversation(A, { channel: 'instagram', conversationExternalId: 't1', customer: { externalId: 'c1', displayName: 'Оксана' } }).conversation.id;
  catalog.createProduct(A, {
    name: 'Худі',
    priceMinor: 100_000,
    currency: 'UAH',
    variants: [
      { sku: 'H-M', options: { size: 'M' }, stock: 3 },
      { sku: 'H-L', options: { size: 'L' }, priceMinor: 110_000, stock: 1 },
      { sku: 'H-XL', options: { size: 'XL' }, stock: 0 },
    ],
  });
});
afterEach(() => h.close());

const draftInput = (items: Array<{ sku: string; quantity: number }>, over: Record<string, unknown> = {}) => ({ conversationId: convA, createdBy: 'ai' as const, items, contactName: 'Оксана', contactPhone: '+380501112233', ...over });
const stockOf = (sku: string) => catalog.findVariantBySku(A, sku)!.stock;

describe('quote', () => {
  it('prices from the catalog: variant override, else product price', () => {
    const q = orders.quote(A, [
      { sku: 'h-m', quantity: 2 },
      { sku: 'H-L', quantity: 1 },
    ]);
    expect(q.currency).toBe('UAH');
    expect(q.totalMinor).toBe(2 * 100_000 + 110_000);
    expect(q.lines.map((l) => [l.sku, l.unitPriceMinor, l.lineTotalMinor])).toEqual([
      ['H-M', 100_000, 200_000],
      ['H-L', 110_000, 110_000],
    ]);
  });
  it('merges duplicate SKUs and reports every problem at once', () => {
    expect(orders.quote(A, [{ sku: 'H-M', quantity: 1 }, { sku: 'H-M', quantity: 2 }]).lines[0]!.quantity).toBe(3);
    try {
      orders.quote(A, [{ sku: 'H-M', quantity: 4 }, { sku: 'H-XL', quantity: 1 }, { sku: 'NOPE', quantity: 1 }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OrderValidationError);
      expect((e as OrderValidationError).issues).toEqual(['H-M: requested 4, only 3 in stock', 'H-XL: requested 1, only 0 in stock', 'NOPE: not available in the catalog']);
    }
  });
  it('refuses inactive products and variants, and other shops’ SKUs', () => {
    const p = catalog.listProducts(A).items[0]!;
    catalog.updateVariant(A, p.product.id, p.variants.find((v) => v.sku === 'H-M')!.id, { active: false });
    expect(() => orders.quote(A, [{ sku: 'H-M', quantity: 1 }])).toThrow(OrderValidationError);
    expect(() => orders.quote(B, [{ sku: 'H-L', quantity: 1 }])).toThrow(/not available/);
    catalog.updateProduct(A, p.product.id, { active: false });
    expect(() => orders.quote(A, [{ sku: 'H-L', quantity: 1 }])).toThrow(OrderValidationError);
  });
  it('rejects bad quantities and an empty list', () => {
    expect(() => orders.quote(A, [])).toThrow(OrderValidationError);
    expect(() => orders.quote(A, [{ sku: 'H-M', quantity: 0 }])).toThrow(OrderValidationError);
    expect(() => orders.quote(A, [{ sku: 'H-M', quantity: 1.5 }])).toThrow(OrderValidationError);
  });
});

describe('createDraft', () => {
  it('stores a pending_approval draft with price snapshots and does not touch stock', () => {
    const { draft, items } = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 2 }], { deliveryInfo: 'Київ, НП №5' }));
    expect(draft).toMatchObject({ status: 'pending_approval', createdBy: 'ai', totalMinor: 200_000, currency: 'UAH', deliveryInfo: 'Київ, НП №5', decidedAt: null });
    expect(items).toMatchObject([{ sku: 'H-M', quantity: 2, unitPriceMinor: 100_000, productName: 'Худі', options: { size: 'M' } }]);
    expect(stockOf('H-M')).toBe(3);
  });
  it('snapshots survive later catalog edits', () => {
    const { draft } = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }]));
    const p = catalog.listProducts(A).items[0]!;
    catalog.updateProduct(A, p.product.id, { priceMinor: 999_900, name: 'Інше' });
    const again = orders.getDraft(A, draft.id)!;
    expect(again.draft.totalMinor).toBe(100_000);
    expect(again.items[0]).toMatchObject({ unitPriceMinor: 100_000, productName: 'Худі' });
  });
  it('a newer AI draft cancels the still-pending earlier one in the same conversation', () => {
    const first = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }])).draft;
    const second = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 2 }])).draft;
    expect(orders.getDraft(A, first.id)!.draft).toMatchObject({ status: 'cancelled', decisionNote: 'superseded by a newer draft' });
    expect(orders.getDraft(A, second.id)!.draft.status).toBe('pending_approval');
    expect(orders.listDrafts(A, { status: 'pending_approval' }).total).toBe(1);
  });
  it('rejects a foreign or unknown conversation and invalid items without leaving rows', () => {
    expect(() => orders.createDraft(B, draftInput([{ sku: 'H-M', quantity: 1 }]))).toThrow(/conversationId/);
    expect(() => orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 9 }]))).toThrow(OrderValidationError);
    expect(orders.listDrafts(A).total).toBe(0);
  });
  it('rejects unknown keys (a caller cannot set price or status)', () => {
    expect(() => orders.createDraft(A, { ...draftInput([{ sku: 'H-M', quantity: 1 }]), totalMinor: 1 } as never)).toThrow(OrderValidationError);
    expect(() => orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1, priceMinor: 1 } as never]))).toThrow(OrderValidationError);
  });
});

describe('approve / reject', () => {
  it('approve reduces stock for every line, atomically', () => {
    const { draft } = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 2 }, { sku: 'H-L', quantity: 1 }]));
    const done = orders.approve(A, draft.id, user, 'ok');
    expect(done.draft).toMatchObject({ status: 'approved', decidedByUserId: user, decisionNote: 'ok' });
    expect(done.draft.decidedAt).toBeTruthy();
    expect([stockOf('H-M'), stockOf('H-L')]).toEqual([1, 0]);
  });
  it('fails whole, with no stock change, when any line is no longer covered', () => {
    const { draft } = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 2 }, { sku: 'H-L', quantity: 1 }]));
    const p = catalog.listProducts(A).items[0]!;
    catalog.adjustStock(A, p.product.id, p.variants.find((v) => v.sku === 'H-L')!.id, -1); // sold elsewhere
    expect(() => orders.approve(A, draft.id, user)).toThrow(OrderStockError);
    expect(stockOf('H-M')).toBe(3);
    expect(orders.getDraft(A, draft.id)!.draft.status).toBe('pending_approval');
  });
  it('the same stock cannot be approved twice', () => {
    const a = orders.createDraft(A, draftInput([{ sku: 'H-L', quantity: 1 }], { conversationId: convA })).draft;
    const convB2 = conv.ensureConversation(A, { channel: 'instagram', conversationExternalId: 't2', customer: { externalId: 'c2' } }).conversation.id;
    const b = orders.createDraft(A, draftInput([{ sku: 'H-L', quantity: 1 }], { conversationId: convB2 })).draft;
    orders.approve(A, a.id, user);
    expect(() => orders.approve(A, b.id, user)).toThrow(OrderStockError);
    expect(stockOf('H-L')).toBe(0);
  });
  it('a decided draft cannot be decided again', () => {
    const { draft } = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }]));
    orders.reject(A, draft.id, user, 'не підходить');
    expect(orders.getDraft(A, draft.id)!.draft).toMatchObject({ status: 'rejected', decisionNote: 'не підходить' });
    expect(() => orders.approve(A, draft.id, user)).toThrow(OrderStateError);
    expect(() => orders.reject(A, draft.id, user)).toThrow(OrderStateError);
    expect(stockOf('H-M')).toBe(3);
  });
  it('other shops cannot see or decide a draft', () => {
    const { draft } = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }]));
    expect(orders.getDraft(B, draft.id)).toBeUndefined();
    expect(orders.listDrafts(B).total).toBe(0);
    expect(() => orders.approve(B, draft.id, user)).toThrow(OrderNotFoundError);
    expect(() => orders.reject(B, draft.id, user)).toThrow(OrderNotFoundError);
  });
  it('a deactivated variant cannot be approved', () => {
    const { draft } = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }]));
    const p = catalog.listProducts(A).items[0]!;
    catalog.updateVariant(A, p.product.id, p.variants.find((v) => v.sku === 'H-M')!.id, { active: false });
    expect(() => orders.approve(A, draft.id, user)).toThrow(OrderStockError);
  });
});
