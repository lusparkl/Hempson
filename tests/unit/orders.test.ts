import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentRepository,
  AuthRepository,
  CatalogRepository,
  ConversationRepository,
  CredentialVault,
  Keyring,
  DeliveryRepository,
  OrderNotFoundError,
  OrderRepository,
  OrderStateError,
  OrderStockError,
  OrderValidationError,
  ShopRepository,
  normalizeUaPhone,
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
/** P5: prepaid is offered only with an active payment provider credential. */
const connectMonobank = (shopId: string) => new CredentialVault(h, new Keyring(1, randomBytes(32))).save(shopId, 'monobank', 'test-acquiring-token-0123456789');

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

const checkout = { firstName: 'Оксана', lastName: 'Мельник', phone: '050 111 22 33', npCityRef: 'city-kyiv', npCityName: 'Київ', npWarehouseRef: 'wh-5', npWarehouseName: 'Відділення №5', paymentMethod: 'cod' as const };
const draftInput = (items: Array<{ sku: string; quantity: number }>, over: Record<string, unknown> = {}) => ({ conversationId: convA, createdBy: 'ai' as const, items, contactName: 'Оксана', contactPhone: '+380501112233', checkout, ...over });
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
    expect(done.draft).toMatchObject({ status: 'cod_confirmed', decidedByUserId: user, decisionNote: 'ok', recipientPhone: '+380501112233' });
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

describe('checkout and refusal limit (P4, D25)', () => {
  let delivery: DeliveryRepository;
  beforeEach(() => {
    delivery = new DeliveryRepository(h);
  });
  /** One COD order of the default customer (+380501112233) refused at the branch. */
  const refuse = () => {
    const d = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }], { conversationId: convA })).draft;
    orders.approve(A, d.id, user);
    orders.claimTtn(A, d.id);
    orders.completeTtn(A, d.id, { ttn: `2045${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, documentRef: 'doc' });
    orders.applyTracking(A, d.id, { code: '103', text: 'Відмова одержувача', outcome: 'returning', refusal: true });
    return d.id;
  };

  it('normalizes Ukrainian phone spellings and rejects others', () => {
    for (const p of ['+380501112233', '380501112233', '0501112233', '050 111 22 33', '(050) 111-22-33', '+38 050 111 22 33']) expect(normalizeUaPhone(p)).toBe('+380501112233');
    for (const p of ['12345', '+48501112233', '050111223', 'abc', '00501112233']) expect(normalizeUaPhone(p)).toBeNull();
  });
  it('a draft without checkout data cannot be approved', () => {
    const { draft } = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }], { checkout: undefined }));
    expect(() => orders.approve(A, draft.id, user)).toThrow(/checkout data incomplete: recipient name, phone, Nova Poshta city, Nova Poshta branch, payment method/);
    expect(stockOf('H-M')).toBe(3);
    expect(orders.getDraft(A, draft.id)!.draft.status).toBe('pending_approval');
  });
  it('rejects a bad phone and a payment method the shop does not offer', () => {
    expect(() => orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }], { checkout: { ...checkout, phone: '12345' } }))).toThrow(/not a Ukrainian phone/);
    expect(() => orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }], { checkout: { ...checkout, paymentMethod: 'prepaid' } }))).toThrow(/prepaid is not offered/);
    delivery.updateSettings(A, { prepaidEnabled: true });
    // The switch alone is not enough: without a connected payment provider no link could be sent (P5).
    expect(() => orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }], { checkout: { ...checkout, paymentMethod: 'prepaid' } }))).toThrow(/prepaid is not offered/);
    connectMonobank(A);
    expect(orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }], { checkout: { ...checkout, paymentMethod: 'prepaid' } })).draft.paymentMethod).toBe('prepaid');
  });
  it('at the refusal limit COD is refused server-side, counted by normalized phone across conversations', () => {
    refuse();
    expect(delivery.countRefusals(A, { phone: '+380501112233' })).toBe(1);
    expect(delivery.paymentMethods(A, { phone: '+380501112233' })).toMatchObject({ methods: [], refusals: 1, codBlocked: true });
    const convOther = conv.ensureConversation(A, { channel: 'telegram', conversationExternalId: '77', customer: { externalId: '77' } }).conversation.id;
    expect(() => orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }], { conversationId: convOther, checkout: { ...checkout, phone: '(050) 111-22-33' } }))).toThrow(/cash on delivery is not available/);
    // Another phone is unaffected; another shop never sees the refusal.
    expect(orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }], { conversationId: convOther, checkout: { ...checkout, phone: '0671112233' } })).draft.paymentMethod).toBe('cod');
    expect(delivery.countRefusals(B, { phone: '+380501112233' })).toBe(0);
  });
  it('limit 0 turns the rule off; limit 2 allows one refusal; a member may remove a refusal', () => {
    refuse();
    delivery.updateSettings(A, { refusalLimit: 0 });
    expect(delivery.paymentMethods(A, { phone: '+380501112233' }).methods).toEqual(['cod']);
    delivery.updateSettings(A, { refusalLimit: 2 });
    expect(delivery.paymentMethods(A, { phone: '+380501112233' }).methods).toEqual(['cod']);
    const r = delivery.addMemberRefusal(A, { customerId: conv.getConversation(A, convA)!.customer.id }, user, '+380501112233');
    expect(delivery.paymentMethods(A, { phone: '+380501112233' }).codBlocked).toBe(true);
    delivery.removeRefusal(A, r.id);
    expect(delivery.paymentMethods(A, { phone: '+380501112233' }).codBlocked).toBe(false);
    expect(() => delivery.updateSettings(A, { refusalLimit: 4 })).toThrow();
  });
});

describe('order lifecycle (D25)', () => {
  const approved = (qty = 2) => {
    const { draft } = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: qty }]));
    orders.approve(A, draft.id, user);
    return draft.id;
  };
  const ship = (id: string, ttn = '20450000000001') => {
    orders.claimTtn(A, id);
    return orders.completeTtn(A, id, { ttn, documentRef: 'doc-1' });
  };

  it('approval moves COD to cod_confirmed (prepaid to awaiting_payment) and writes every transition', () => {
    const id = approved();
    expect(orders.getDraft(A, id)!.draft).toMatchObject({ status: 'cod_confirmed', approvedAt: expect.any(String) });
    expect(orders.listEvents(A, id).map((e) => [e.fromStatus, e.toStatus, e.actor])).toEqual([
      [null, 'pending_approval', 'ai'],
      ['pending_approval', 'approved', `user:${user}`],
      ['approved', 'cod_confirmed', `user:${user}`],
    ]);
    new DeliveryRepository(h).updateSettings(A, { prepaidEnabled: true });
    connectMonobank(A);
    const p = orders.createDraft(A, draftInput([{ sku: 'H-L', quantity: 1 }], { checkout: { ...checkout, paymentMethod: 'prepaid' } })).draft;
    expect(orders.approve(A, p.id, user).draft.status).toBe('awaiting_payment');
    // Prepaid orders get a TTN only from `paid` (P5).
    expect(() => orders.claimTtn(A, p.id)).toThrow(OrderStateError);
  });
  it('the TTN is claimed at most once; only NP results set it', () => {
    const id = approved();
    orders.claimTtn(A, id);
    expect(() => orders.claimTtn(A, id)).toThrow(/being created/);
    orders.failTtn(A, id, 'failed', 'NP_REJECTED');
    orders.claimTtn(A, id); // a refused attempt may be retried
    orders.failTtn(A, id, 'uncertain', 'NP_NO_ANSWER');
    expect(() => orders.claimTtn(A, id)).toThrow(/uncertain/);
    orders.releaseUncertainTtn(A, id);
    const shipped = ship(id);
    expect(shipped.draft).toMatchObject({ status: 'shipped', ttn: '20450000000001', ttnState: 'created' });
    expect(() => orders.claimTtn(A, id)).toThrow(/already has a TTN/);
    expect(() => orders.completeTtn(A, id, { ttn: '20450000000002', documentRef: 'x' })).toThrow(OrderStateError);
  });
  it('cancel before shipping restores stock once; not while a parcel may exist', () => {
    const id = approved();
    expect(stockOf('H-M')).toBe(1);
    orders.cancel(A, id, user, 'клієнт передумав');
    expect(stockOf('H-M')).toBe(3);
    expect(() => orders.cancel(A, id, user)).toThrow(OrderStateError);
    expect(stockOf('H-M')).toBe(3);
    const id2 = approved(1);
    orders.claimTtn(A, id2);
    orders.failTtn(A, id2, 'uncertain', 'NP_NO_ANSWER');
    expect(() => orders.cancel(A, id2, user)).toThrow(/parcel may exist/);
    const pending = orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }])).draft;
    expect(() => orders.cancel(A, pending.id, user)).toThrow(/cannot be cancelled/);
  });
  it('tracking: delivered once; refused parcel goes returning without restock and counts one refusal; returned restocks once', () => {
    const id = approved();
    ship(id);
    expect(orders.applyTracking(A, id, { code: '5', text: 'Прямує до міста', outcome: null, refusal: false })).toEqual({ transition: null });
    expect(orders.getDraft(A, id)!.draft).toMatchObject({ status: 'shipped', npStatusCode: '5', npStatusText: 'Прямує до міста' });
    expect(orders.applyTracking(A, id, { code: '103', text: 'Відмова', outcome: 'returning', refusal: true })).toEqual({ transition: 'returning' });
    expect(orders.applyTracking(A, id, { code: '103', text: 'Відмова', outcome: 'returning', refusal: true })).toEqual({ transition: null });
    expect(new DeliveryRepository(h).countRefusals(A, { phone: '+380501112233' })).toBe(1);
    expect(stockOf('H-M')).toBe(1);
    expect(() => orders.cancel(A, id, user)).toThrow(OrderStateError);
    orders.markReturned(A, id, user);
    expect(stockOf('H-M')).toBe(3);
    expect(() => orders.markReturned(A, id, user)).toThrow(OrderStateError);
    expect(stockOf('H-M')).toBe(3);

    new DeliveryRepository(h).updateSettings(A, { refusalLimit: 0 }); // the same customer orders again
    const id2 = approved(1);
    ship(id2, '20450000000002');
    expect(orders.applyTracking(A, id2, { code: '9', text: 'Отримано', outcome: 'delivered', refusal: false })).toEqual({ transition: 'delivered' });
    expect(orders.applyTracking(A, id2, { code: '103', text: 'x', outcome: 'returning', refusal: true })).toEqual({ transition: null });
    expect(orders.getDraft(A, id2)!.draft.status).toBe('delivered');
    expect(orders.listForTracking().map((d) => d.id)).toEqual([]);
  });
  it('a member may mark returned without restock (damaged goods)', () => {
    const id = approved(1);
    ship(id);
    orders.applyTracking(A, id, { code: '105', text: 'Припинено зберігання', outcome: 'returning', refusal: false });
    expect(new DeliveryRepository(h).countRefusals(A, { phone: '+380501112233' })).toBe(0);
    orders.markReturned(A, id, user, { restock: false });
    expect(stockOf('H-M')).toBe(2);
    expect(orders.listEvents(A, id).at(-1)).toMatchObject({ toStatus: 'returned', note: 'returned without restock' });
  });
});

describe('auto_confirm (D26)', () => {
  let agent: AgentRepository;
  beforeEach(() => {
    agent = new AgentRepository(h);
  });
  const draft = (over: Record<string, unknown> = {}) => orders.createDraft(A, draftInput([{ sku: 'H-M', quantity: 1 }], over)).draft.id;

  it('approves as system:auto_confirm when every check passes', () => {
    const r = orders.autoConfirm(A, draft(), { maxTotalMinor: null });
    expect(r).toMatchObject({ approved: true, draft: { draft: { status: 'cod_confirmed', decidedByUserId: null } } });
    expect(orders.listEvents(A, (r as { draft: { draft: { id: string } } }).draft.draft.id).at(-1)!.actor).toBe('system:auto_confirm');
    expect(stockOf('H-M')).toBe(2);
  });
  it('leaves the draft for a person on any failed check', () => {
    expect(orders.autoConfirm(A, draft({ checkout: undefined }), { maxTotalMinor: null })).toEqual({ approved: false, reason: 'CHECKOUT_INCOMPLETE' });
    expect(orders.autoConfirm(A, draft(), { maxTotalMinor: 50_000 })).toEqual({ approved: false, reason: 'OVER_CAP' });
    const id = draft();
    agent.escalate(A, convA, 'питання');
    expect(orders.autoConfirm(A, id, { maxTotalMinor: null })).toEqual({ approved: false, reason: 'ESCALATION_OPEN' });
    agent.resolveEscalation(A, agent.listEscalations(A).items[0]!.id, null);
    conv.setAiPaused(A, convA, true, user);
    expect(orders.autoConfirm(A, id, { maxTotalMinor: null })).toEqual({ approved: false, reason: 'AI_PAUSED' });
    conv.setAiPaused(A, convA, false, user);
    const p = catalog.listProducts(A).items[0]!;
    catalog.updateProduct(A, p.product.id, { priceMinor: 120_000 });
    expect(orders.autoConfirm(A, id, { maxTotalMinor: null })).toEqual({ approved: false, reason: 'PRICE_CHANGED' });
    expect(orders.getDraft(A, id)!.draft.status).toBe('pending_approval');
    expect(stockOf('H-M')).toBe(3);
  });
  it('never confirms COD for a customer at the refusal limit', () => {
    const id = draft();
    new DeliveryRepository(h).addMemberRefusal(A, { customerId: conv.getConversation(A, convA)!.customer.id }, user, '+380501112233');
    expect(orders.autoConfirm(A, id, { maxTotalMinor: null })).toEqual({ approved: false, reason: 'COD_REFUSAL_LIMIT' });
  });
});
