import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, runMigrations, ShopNotFoundError, ShopRepository, ShopSlugTakenError, ShopValidationError, type DbHandle } from '@hepson/database';

let h: DbHandle;
let repo: ShopRepository;
let tick: number;
beforeEach(() => {
  h = openDb(':memory:');
  runMigrations(h);
  tick = Date.UTC(2026, 0, 1);
  repo = new ShopRepository(h, () => new Date((tick += 1000)));
});
afterEach(() => h.close());

describe('ShopRepository', () => {
  it('creates with defaults and fetches by id and slug', () => {
    const s = repo.create({ name: '  Мій магазин ', slug: 'my-shop' });
    expect(s).toMatchObject({ name: 'Мій магазин', slug: 'my-shop', defaultCurrency: 'UAH', defaultLanguage: 'uk' });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.createdAt).toBe(s.updatedAt);
    expect(repo.get(s.id)).toEqual(s);
    expect(repo.getBySlug('my-shop')).toEqual(s);
    expect(repo.get('missing')).toBeUndefined();
  });

  it('accepts explicit currency and language', () => {
    expect(repo.create({ name: 'Shop', slug: 'shop-pl', defaultCurrency: 'PLN', defaultLanguage: 'pl' })).toMatchObject({ defaultCurrency: 'PLN', defaultLanguage: 'pl' });
  });

  it('lists in creation order', () => {
    const a = repo.create({ name: 'A', slug: 'aa' });
    const b = repo.create({ name: 'B', slug: 'bb' });
    expect(repo.list().map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it('rejects duplicate slug on create and update', () => {
    repo.create({ name: 'A', slug: 'aa' });
    const b = repo.create({ name: 'B', slug: 'bb' });
    expect(() => repo.create({ name: 'C', slug: 'aa' })).toThrow(ShopSlugTakenError);
    expect(() => repo.update(b.id, { slug: 'aa' })).toThrow(ShopSlugTakenError);
    expect(repo.get(b.id)?.slug).toBe('bb');
  });

  it.each([
    [{ name: '', slug: 'ok' }],
    [{ name: '   ', slug: 'ok' }],
    [{ name: 'x', slug: 'Bad Slug' }],
    [{ name: 'x', slug: '-lead' }],
    [{ name: 'x', slug: 'a' }],
    [{ name: 'x', slug: 'ok', defaultCurrency: 'uah' }],
    [{ name: 'x', slug: 'ok', defaultLanguage: 'ukrainian' }],
    [{ name: 'x', slug: 'ok', id: 'forced' }],
    [{ slug: 'ok' }],
  ])('rejects invalid create %j', (input) => {
    expect(() => repo.create(input as never)).toThrow(ShopValidationError);
    expect(repo.list()).toHaveLength(0);
  });

  it('updates fields and bumps updatedAt only', () => {
    const s = repo.create({ name: 'A', slug: 'aa' });
    const u = repo.update(s.id, { name: 'New', defaultCurrency: 'EUR' });
    expect(u).toMatchObject({ id: s.id, name: 'New', slug: 'aa', defaultCurrency: 'EUR', defaultLanguage: 'uk', createdAt: s.createdAt });
    expect(u.updatedAt > s.updatedAt).toBe(true);
    expect(repo.get(s.id)).toEqual(u);
  });

  it('rejects invalid, empty or immutable-field updates and unknown id', () => {
    const s = repo.create({ name: 'A', slug: 'aa' });
    expect(() => repo.update(s.id, {})).toThrow(ShopValidationError);
    expect(() => repo.update(s.id, { slug: 'BAD' })).toThrow(ShopValidationError);
    expect(() => repo.update(s.id, { id: 'x' } as never)).toThrow(ShopValidationError);
    expect(() => repo.update('missing', { name: 'x' })).toThrow(ShopNotFoundError);
    expect(repo.get(s.id)).toEqual(s);
  });
});

describe('persistence', () => {
  it('survives reopen of a file database', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hepson-shops-'));
    try {
      const file = path.join(dir, 'x.db');
      const a = openDb(file);
      runMigrations(a);
      const s = new ShopRepository(a).create({ name: 'A', slug: 'aa' });
      a.close();
      const b = openDb(file);
      runMigrations(b);
      expect(new ShopRepository(b).get(s.id)).toEqual(s);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
