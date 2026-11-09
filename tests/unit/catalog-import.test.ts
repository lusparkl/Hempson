import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogRepository, CatalogValidationError, ShopRepository, importCatalogCsv, openDb, parseCsv, parsePriceMinor, runMigrations, type DbHandle } from '@hepson/database';

let h: DbHandle;
let c: CatalogRepository;
let A: string;
let B: string;
beforeEach(async () => {
  h = openDb(':memory:');
  await runMigrations(h);
  const shops = new ShopRepository(h);
  A = (await shops.create({ name: 'A', slug: 'aa' })).id;
  B = (await shops.create({ name: 'B', slug: 'bb' })).id;
  c = new CatalogRepository(h);
});
afterEach(() => h.close());

const run = async (csv: string, dryRun = false, shop = A) => await importCatalogCsv(c, shop, csv, { dryRun, currency: 'UAH' });

describe('csv parsing', () => {
  it('handles quotes, escaped quotes, newlines in quotes, CRLF and blank lines', () => {
    const rows = parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\nc,d\n', ',');
    expect(rows.map((r) => r.cells)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
      ['c', 'd'],
    ]);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 5]);
  });
  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,b\n"oops,1\n', ',')).toThrow(CatalogValidationError);
  });
  it.each([
    ['499', 49900],
    ['499.5', 49950],
    ['499,50', 49950],
    ['0', 0],
    ['1 299,00', 129900],
  ])('price %s', (s, n) => expect(parsePriceMinor(s)).toBe(n));
  it.each(['1,299.00', '-5', 'abc', '1.234', ''])('rejects price %j', (s) => expect(() => parsePriceMinor(s)).toThrow());
});

describe('importCatalogCsv', () => {
  it('creates products; semicolon delimiter, BOM, Ukrainian headers, decimal comma', async () => {
    const r = await run('﻿артикул;назва;ціна;залишок\ntee-1;Футболка;499,00;5\nmug;Чашка;120;0\n');
    expect(r).toMatchObject({ applied: true, rows: 2, created: { products: 2, variants: 2 }, errors: [] });
    const p = (await c.findVariantBySku(A, 'TEE-1'))!;
    expect(p).toMatchObject({ stock: 5 });
    expect(p.product).toMatchObject({ name: 'Футболка', priceMinor: 49900, currency: 'UAH' });
  });

  it('groups rows into variants with options and variant price', async () => {
    const r = await run('sku,name,price,stock,group,options,variant_price\nJ-M,Куртка,1000,2,jacket,size=M|color=black,\nJ-L,Куртка,1000,1,jacket,size=L|color=black,1500\n');
    expect(r).toMatchObject({ applied: true, created: { products: 1, variants: 2 } });
    const list = await c.listProducts(A);
    expect(list.total).toBe(1);
    const vs = [...list.items[0]!.variants].sort((x, y) => x.sku.localeCompare(y.sku));
    expect(vs.map((v) => [v.sku, v.options, v.priceMinor, v.stock])).toEqual([
      ['J-L', { size: 'L', color: 'black' }, 150000, 1],
      ['J-M', { size: 'M', color: 'black' }, null, 2],
    ]);
  });

  it('updates by SKU: sets stock, leaves empty cells alone, reports only real changes, adds a variant', async () => {
    await run('sku,name,price,stock,description\nA1,Товар,100,5,Опис\n');
    const r = await run('sku,price,stock,name\nA1,,9,\nA1x,,,\n'.replace('A1x,,,\n', ''));
    expect(r).toMatchObject({ applied: true, created: { products: 0, variants: 0 }, updated: { products: 0, variants: 1 } });
    const v = (await c.findVariantBySku(A, 'A1'))!;
    expect(v.stock).toBe(9);
    expect(v.product).toMatchObject({ name: 'Товар', description: 'Опис', priceMinor: 10000 });
    const same = await run('sku,price,stock\nA1,100,9\n');
    expect(same).toMatchObject({ applied: true, updated: { products: 0, variants: 0 } });
    const price = await run('sku,price\nA1,150\n');
    expect(price.updated).toEqual({ products: 1, variants: 0 });
    const addV = await run('sku,group,options,stock\nA1,g,size=S,9\nA2,g,size=M,3\n');
    expect(addV).toMatchObject({ applied: true, created: { products: 0, variants: 1 } });
    expect((await c.getProduct(A, (await c.findVariantBySku(A, 'A1'))!.productId))!.variants).toHaveLength(2);
  });

  it('images: links separated by |, the first is the main image; updates replace the list; bad links are row errors', async () => {
    expect(await run('sku,name,price,images\nIMG-1,Сукня,100,https://a.example/1.jpg | https://a.example/2.jpg\n')).toMatchObject({ applied: true });
    const v = (await c.findVariantBySku(A, 'IMG-1'))!;
    expect((await c.getProduct(A, v.productId))!.product.media).toEqual(['https://a.example/1.jpg', 'https://a.example/2.jpg']);
    expect(await run('sku,фото\nIMG-1,https://a.example/3.jpg\n')).toMatchObject({ applied: true, updated: { products: 1 } });
    expect((await c.getProduct(A, v.productId))!.product.media).toEqual(['https://a.example/3.jpg']);
    expect(await run('sku,image\nIMG-1,https://a.example/3.jpg\n')).toMatchObject({ updated: { products: 0 } });
    expect((await run('sku,image\nIMG-1,javascript:alert(1)\n')).errors).toEqual([{ line: 2, message: expect.stringMatching(/http\(s\) links/) }]);
  });

  it('dry run reports counts but writes nothing', async () => {
    const r = await run('sku,name,price\nx1,X,10\nx2,Y,20\n', true);
    expect(r).toMatchObject({ dryRun: true, applied: false, created: { products: 2, variants: 2 }, errors: [] });
    expect((await c.listProducts(A)).total).toBe(0);
  });

  it('any bad row writes nothing; errors carry line numbers', async () => {
    const r = await run('sku,name,price,stock\nok1,Ok,10,1\nbad,,10,1\nok2,Ok2,abc,1\nok3,Ok3,10,-2\nok1,Dup,10,1\nbad sku!,N,10,1\n');
    expect(r.applied).toBe(false);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7]);
    expect(r.errors[0]!.message).toMatch(/name is required/);
    expect(r.errors[3]!.message).toMatch(/repeats line 2/);
    expect((await c.listProducts(A)).total).toBe(0);
  });

  it('a SKU used by another shop is fine; shops stay isolated', async () => {
    await run('sku,name,price\nsame,Одне,10\n', false, B);
    const r = await run('sku,name,price,stock\nsame,Інше,20,4\n');
    expect(r).toMatchObject({ applied: true, created: { products: 1 }, updated: { products: 0 } });
    expect((await c.findVariantBySku(B, 'SAME'))!.product.name).toBe('Одне');
    expect((await c.findVariantBySku(A, 'SAME'))!.product.name).toBe('Інше');
  });

  it('group conflicts are errors', async () => {
    const r = await run('sku,name,price,group\na,One,10,g\nb,Two,10,g\n');
    expect(r.applied).toBe(false);
    expect(r.errors[0]!.message).toMatch(/disagree on name/);
    await run('sku,name,price\ne1,E1,10\ne2,E2,10\n');
    const r2 = await run('sku,group\ne1,g\ne2,g\n');
    expect(r2.errors[0]!.message).toMatch(/different existing products/);
  });

  it('header problems throw; unknown columns are warned about', async () => {
    await expect(async () => await run('name,price\nX,1\n')).rejects.toThrow(/sku/);
    await expect(async () => await run('')).rejects.toThrow(/empty/);
    await expect(async () => await run('sku,sku\na,b\n')).rejects.toThrow(/twice/);
    expect((await run('sku,name,price,colour\nz,Z,1,red\n')).warnings[0]).toMatch(/colour/);
  });

  it('active=false hides a variant', async () => {
    await run('sku,name,price\nh1,H,10\n');
    await run('sku,active\nh1,ні\n');
    expect((await c.findVariantBySku(A, 'H1'))!.active).toBe(false);
  });

  it('rejects files over the row limit', async () => {
    const csv = 'sku,name,price\n' + Array.from({ length: 5001 }, (_, i) => `s${i},N,1`).join('\n');
    await expect(async () => await run(csv)).rejects.toThrow(/too many rows/);
  });
});
