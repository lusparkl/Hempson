import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import * as t from './schema';

export type ShopRow = typeof t.shops.$inferSelect;

export class ShopValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid shop: ${issues.join('; ')}`);
    this.name = 'ShopValidationError';
  }
}
export class ShopSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`shop slug already in use: ${slug}`);
    this.name = 'ShopSlugTakenError';
  }
}
export class ShopNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`shop not found: ${id}`);
    this.name = 'ShopNotFoundError';
  }
}

const name = z.string().trim().min(1).max(120);
const slug = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits, single hyphens');
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. UAH');
const language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'BCP 47 tag, e.g. uk');

const createSchema = z.strictObject({
  name,
  slug,
  defaultCurrency: currency.default('UAH'),
  defaultLanguage: language.default('uk'),
});
const updateSchema = z
  .strictObject({ name, slug, defaultCurrency: currency, defaultLanguage: language })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'no fields to update');

export type CreateShopInput = z.input<typeof createSchema>;
export type UpdateShopInput = z.input<typeof updateSchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ShopValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
  return r.data;
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE';

/** Internal service: no HTTP exposure and no authorization yet (Feature 2 adds memberships). */
export class ShopRepository {
  readonly db: Db;
  constructor(
    handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }

  create(input: CreateShopInput): ShopRow {
    const v = parse(createSchema, input);
    const ts = this.clock().toISOString();
    const row: ShopRow = { id: randomUUID(), ...v, createdAt: ts, updatedAt: ts };
    try {
      this.db.insert(t.shops).values(row).run();
    } catch (e) {
      if (isUniqueViolation(e)) throw new ShopSlugTakenError(v.slug);
      throw e;
    }
    return row;
  }

  get(id: string): ShopRow | undefined {
    return this.db.select().from(t.shops).where(eq(t.shops.id, id)).get();
  }

  getBySlug(slugValue: string): ShopRow | undefined {
    return this.db.select().from(t.shops).where(eq(t.shops.slug, slugValue)).get();
  }

  list(): ShopRow[] {
    return this.db.select().from(t.shops).orderBy(asc(t.shops.createdAt), asc(t.shops.slug)).all();
  }

  update(id: string, input: UpdateShopInput): ShopRow {
    const v = parse(updateSchema, input);
    try {
      const row = this.db.update(t.shops).set({ ...v, updatedAt: this.clock().toISOString() }).where(eq(t.shops.id, id)).returning().get();
      if (!row) throw new ShopNotFoundError(id);
      return row;
    } catch (e) {
      if (isUniqueViolation(e)) throw new ShopSlugTakenError(v.slug ?? '');
      throw e;
    }
  }
}
