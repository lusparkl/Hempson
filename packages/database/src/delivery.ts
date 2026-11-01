import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import type { PAYMENT_METHODS } from './order-kinds';
import * as t from './schema';

export type DeliverySettingsRow = typeof t.shopDeliverySettings.$inferSelect;
export type RefusalRow = typeof t.customerRefusals.$inferSelect;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export class DeliveryValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid delivery input: ${issues.join('; ')}`);
    this.name = 'DeliveryValidationError';
  }
}
export class RefusalNotFoundError extends Error {
  constructor() {
    super('refusal not found');
    this.name = 'RefusalNotFoundError';
  }
}

/**
 * Ukrainian phone number in `+380XXXXXXXXX` form, or null. Accepts the usual spellings (`050 111 22 33`, `(050)111-22-33`,
 * `380501112233`, `+38 050 ...`). Refusals and Nova Poshta both key on this form.
 */
export function normalizeUaPhone(raw: string): string | null {
  const d = raw.replace(/[\s()+.-]/g, '');
  if (!/^\d+$/.test(d)) return null;
  const nine = d.length === 12 && d.startsWith('380') ? d.slice(3) : d.length === 10 && d.startsWith('0') ? d.slice(1) : d.length === 11 && d.startsWith('80') ? d.slice(2) : null;
  return nine && /^[1-9]\d{8}$/.test(nine) ? `+380${nine}` : null;
}

const ref = z.string().trim().min(1).max(64);
const settingsInput = z.strictObject({
  senderCityRef: ref.nullable().optional(),
  senderCityName: z.string().trim().max(200).nullable().optional(),
  senderWarehouseRef: ref.nullable().optional(),
  senderWarehouseName: z.string().trim().max(300).nullable().optional(),
  codEnabled: z.boolean().optional(),
  prepaidEnabled: z.boolean().optional(),
  refusalLimit: z.number().int().min(0).max(3).optional(),
  parcelWeightKg: z
    .string()
    .trim()
    .regex(/^\d{1,3}(?:[.,]\d{1,3})?$/, 'kilograms, e.g. 0.5')
    .transform((s) => s.replace(',', '.'))
    .optional(),
  parcelDescription: z.string().trim().min(1).max(100).optional(),
});
const refusalInput = z.strictObject({ customerId: z.uuid(), note: z.string().trim().max(500).optional() });

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);

/**
 * Nova Poshta sender/checkout settings and the per-customer refusal count (P4, D25). Every method takes `shopId` first
 * and filters by it. Internal: no authorization here.
 */
export class DeliveryRepository {
  readonly db: Db;
  constructor(
    handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }
  private now() {
    return this.clock().toISOString();
  }

  getSettings(shopId: string): DeliverySettingsRow {
    return (
      this.db.select().from(t.shopDeliverySettings).where(eq(t.shopDeliverySettings.shopId, shopId)).get() ?? {
        shopId,
        senderRef: null,
        senderContactRef: null,
        senderPhone: null,
        senderCityRef: null,
        senderCityName: null,
        senderWarehouseRef: null,
        senderWarehouseName: null,
        codEnabled: true,
        prepaidEnabled: false,
        refusalLimit: 1,
        parcelWeightKg: '1',
        parcelDescription: 'Товар',
        lastError: null,
        updatedAt: '',
      }
    );
  }

  private write(shopId: string, patch: Partial<Omit<DeliverySettingsRow, 'shopId'>>): DeliverySettingsRow {
    const row = { ...this.getSettings(shopId), ...patch, shopId, updatedAt: this.now() };
    const { shopId: _s, ...set } = row;
    this.db.insert(t.shopDeliverySettings).values(row).onConflictDoUpdate({ target: t.shopDeliverySettings.shopId, set }).run();
    return row;
  }

  updateSettings(shopId: string, input: z.input<typeof settingsInput>): DeliverySettingsRow {
    const r = settingsInput.safeParse(input);
    if (!r.success) throw new DeliveryValidationError(issues(r.error));
    const patch = Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined));
    return this.write(shopId, patch);
  }

  /** Sender identity read from Nova Poshta when the owner saves the key. */
  setSender(shopId: string, s: { senderRef: string | null; senderContactRef: string | null; senderPhone: string | null }): DeliverySettingsRow {
    return this.write(shopId, { ...s, lastError: null });
  }

  setLastError(shopId: string, code: string | null): void {
    this.write(shopId, { lastError: code });
  }

  /** Sender settings needed to create a TTN are present (the key is checked separately). */
  senderComplete(s: DeliverySettingsRow): boolean {
    return !!(s.senderRef && s.senderContactRef && s.senderPhone && s.senderCityRef && s.senderWarehouseRef);
  }

  // ---------- refusals (D25) ----------

  /** Counted by normalized phone when one is known (plus phoneless rows of the same customer), else by customer id. */
  private refusalWhere(shopId: string, who: { phone?: string | null; customerId?: string | null }): SQL | undefined {
    const byCustomer = who.customerId ? eq(t.customerRefusals.customerId, who.customerId) : undefined;
    if (who.phone) return and(eq(t.customerRefusals.shopId, shopId), or(eq(t.customerRefusals.phone, who.phone), byCustomer && and(byCustomer, isNull(t.customerRefusals.phone))));
    return byCustomer && and(eq(t.customerRefusals.shopId, shopId), byCustomer);
  }

  countRefusals(shopId: string, who: { phone?: string | null; customerId?: string | null }): number {
    const where = this.refusalWhere(shopId, who);
    return where ? this.db.select({ n: sql<number>`count(*)` }).from(t.customerRefusals).where(where).get()!.n : 0;
  }

  listRefusals(shopId: string, who: { phone?: string | null; customerId?: string | null }): RefusalRow[] {
    const where = this.refusalWhere(shopId, who);
    return where ? this.db.select().from(t.customerRefusals).where(where).orderBy(desc(t.customerRefusals.createdAt)).all() : [];
  }

  /**
   * Payment methods this customer may use now. COD disappears at the shop's refusal limit (0 = rule off). Prepaid needs
   * the owner's switch and an active payment provider credential (P5): without one no link could ever be sent.
   */
  paymentMethods(shopId: string, who: { phone?: string | null; customerId?: string | null }): { methods: PaymentMethod[]; refusals: number; codBlocked: boolean } {
    const s = this.getSettings(shopId);
    const refusals = this.countRefusals(shopId, who);
    const codBlocked = s.refusalLimit > 0 && refusals >= s.refusalLimit;
    const methods: PaymentMethod[] = [];
    if (s.codEnabled && !codBlocked) methods.push('cod');
    if (s.prepaidEnabled && this.paymentProviderReady(shopId)) methods.push('prepaid');
    return { methods, refusals, codBlocked };
  }

  /** An active payment provider credential exists (checked by row status only; the secret is never read here). */
  paymentProviderReady(shopId: string): boolean {
    return !!this.db
      .select({ id: t.shopCredentials.id })
      .from(t.shopCredentials)
      .where(and(eq(t.shopCredentials.shopId, shopId), eq(t.shopCredentials.kind, 'monobank'), eq(t.shopCredentials.status, 'active')))
      .get();
  }

  /** One refusal per order from Nova Poshta tracking; returns false when that order was already counted. */
  recordProviderRefusal(shopId: string, r: { draftId: string; customerId: string; phone: string | null }): boolean {
    const res = this.db
      .insert(t.customerRefusals)
      .values({ id: randomUUID(), shopId, customerId: r.customerId, phone: r.phone, draftId: r.draftId, source: 'nova_poshta', createdByUserId: null, note: null, createdAt: this.now() })
      .onConflictDoNothing()
      .run();
    return res.changes > 0;
  }

  /** A member records a refusal by hand (the customer's latest known phone is attached when the caller passes it). */
  addMemberRefusal(shopId: string, input: z.input<typeof refusalInput>, userId: string, phone: string | null): RefusalRow {
    const r = refusalInput.safeParse(input);
    if (!r.success) throw new DeliveryValidationError(issues(r.error));
    const customer = this.db
      .select({ id: t.customers.id })
      .from(t.customers)
      .where(and(eq(t.customers.shopId, shopId), eq(t.customers.id, r.data.customerId)))
      .get();
    if (!customer) throw new DeliveryValidationError(['customerId: not found']);
    const row: RefusalRow = { id: randomUUID(), shopId, customerId: customer.id, phone, draftId: null, source: 'member', createdByUserId: userId, note: r.data.note ?? null, createdAt: this.now() };
    this.db.insert(t.customerRefusals).values(row).run();
    return row;
  }

  removeRefusal(shopId: string, refusalId: string): void {
    const r = this.db
      .delete(t.customerRefusals)
      .where(and(eq(t.customerRefusals.shopId, shopId), eq(t.customerRefusals.id, refusalId)))
      .run();
    if (!r.changes) throw new RefusalNotFoundError();
  }
}
