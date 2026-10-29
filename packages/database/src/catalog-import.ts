import type { CatalogRepository } from './catalog';
import { CatalogValidationError, SkuTakenError } from './catalog';

export const MAX_IMPORT_ROWS = 5000;

export type ImportError = { line: number; message: string };
export type ImportResult = {
  dryRun: boolean;
  /** True only when the whole file was written. Any error means nothing was written. */
  applied: boolean;
  rows: number;
  created: { products: number; variants: number };
  updated: { products: number; variants: number };
  errors: ImportError[];
  warnings: string[];
};

type Field = 'sku' | 'name' | 'price' | 'stock' | 'description' | 'active' | 'group' | 'options' | 'variantPrice';
const ALIASES: Record<string, Field> = {
  sku: 'sku',
  артикул: 'sku',
  name: 'name',
  назва: 'name',
  price: 'price',
  ціна: 'price',
  stock: 'stock',
  quantity: 'stock',
  залишок: 'stock',
  description: 'description',
  опис: 'description',
  active: 'active',
  активний: 'active',
  group: 'group',
  група: 'group',
  options: 'options',
  опції: 'options',
  variant_price: 'variantPrice',
  ціна_варіанта: 'variantPrice',
};

/** RFC 4180 style: quoted fields, "" escapes, newlines inside quotes. Returns rows with their 1-based start line. */
export function parseCsv(text: string, delimiter: string): Array<{ line: number; cells: string[] }> {
  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endRow = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: startLine, cells });
    cells = [];
    cell = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
      line++;
      startLine = line;
    } else cell += ch;
  }
  if (quoted) throw new CatalogValidationError([`line ${startLine}: unterminated quote`]);
  if (cell !== '' || cells.length) endRow();
  return rows;
}

/** Excel in uk/de locales saves `;`, others `,` (tab for pasted sheets): pick the most frequent in the header line. */
function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let n = 0;
  for (const d of [',', ';', '\t']) {
    const c = head.split(d).length - 1;
    if (c > n) {
      best = d;
      n = c;
    }
  }
  return best;
}

type Row = { line: number; sku: string; name?: string; priceMinor?: number; stock?: number; description?: string; active?: boolean; group: string; options?: Record<string, string>; variantPriceMinor?: number };

/** "499", "499.5", "499,50". No thousands separators (ambiguous), so "1,299" is rejected rather than read as 1.299. */
export function parsePriceMinor(s: string): number {
  const v = s.replace(/[\s ]/g, '');
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(v);
  if (!m) throw new Error(`price "${s}": use digits with an optional .00 or ,00 (no thousands separators)`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}
function parseBool(s: string): boolean {
  const v = s.toLowerCase();
  if (['true', '1', 'yes', 'y', 'так'].includes(v)) return true;
  if (['false', '0', 'no', 'n', 'ні'].includes(v)) return false;
  throw new Error(`active "${s}": use true/false, yes/no, 1/0, так/ні`);
}
function parseOptions(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split('|')) {
    const i = part.indexOf('=');
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (i < 1 || !k || !v) throw new Error(`options "${s}": use name=value separated by |, e.g. size=M|color=red`);
    out[k] = v;
  }
  return out;
}

/** Turns CSV text into typed rows. Header errors throw; per-row problems are returned with their line. */
export function readCatalogCsv(text: string): { rows: Row[]; errors: ImportError[]; warnings: string[] } {
  const clean = text.replace(/^﻿/, '');
  const table = parseCsv(clean, detectDelimiter(clean));
  if (!table.length) throw new CatalogValidationError(['file is empty']);
  if (table.length - 1 > MAX_IMPORT_ROWS) throw new CatalogValidationError([`too many rows: ${table.length - 1} (max ${MAX_IMPORT_ROWS})`]);
  const header = table[0]!.cells.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = new Map<Field, number>();
  const warnings: string[] = [];
  header.forEach((h, i) => {
    const f = ALIASES[h];
    if (!f) warnings.push(`column "${table[0]!.cells[i]!.trim()}" is not recognised and was ignored`);
    else if (col.has(f)) throw new CatalogValidationError([`column "${h}" appears twice`]);
    else col.set(f, i);
  });
  if (!col.has('sku')) throw new CatalogValidationError(['header must contain a "sku" (артикул) column']);

  const rows: Row[] = [];
  const errors: ImportError[] = [];
  for (const { line, cells } of table.slice(1)) {
    const get = (f: Field) => {
      const i = col.get(f);
      return i === undefined ? '' : (cells[i] ?? '').trim();
    };
    try {
      const sku = get('sku');
      if (!sku) throw new Error('sku is empty');
      const r: Row = { line, sku, group: get('group') };
      if (get('name')) r.name = get('name');
      if (get('description')) r.description = get('description');
      if (get('price')) r.priceMinor = parsePriceMinor(get('price'));
      if (get('variantPrice')) r.variantPriceMinor = parsePriceMinor(get('variantPrice'));
      if (get('stock')) {
        if (!/^\d+$/.test(get('stock'))) throw new Error(`stock "${get('stock')}": use a whole number >= 0`);
        r.stock = Number(get('stock'));
      }
      if (get('active')) r.active = parseBool(get('active'));
      if (get('options')) r.options = parseOptions(get('options'));
      rows.push(r);
    } catch (e) {
      errors.push({ line, message: (e as Error).message });
    }
  }
  return { rows, errors, warnings };
}

class Rollback extends Error {
  constructor(readonly result: ImportResult) {
    super('rollback');
  }
}

/**
 * Upserts products/variants by SKU. Rows with the same `group` value become variants of one product
 * (no group = one product per row). Empty cells never overwrite existing data. Stock is SET, not added.
 * `active` applies to the variant only, so a product stays visible while some variant is active.
 * Everything runs in one transaction: any error, or `dryRun`, rolls it all back, so a dry run reports
 * exactly what a real run would do.
 */
export function importCatalogCsv(repo: CatalogRepository, shopId: string, text: string, opts: { dryRun: boolean; currency: string }): ImportResult {
  const parsed = readCatalogCsv(text);
  const result: ImportResult = {
    dryRun: opts.dryRun,
    applied: false,
    rows: parsed.rows.length + parsed.errors.length,
    created: { products: 0, variants: 0 },
    updated: { products: 0, variants: 0 },
    errors: [...parsed.errors],
    warnings: parsed.warnings,
  };

  const seen = new Map<string, number>();
  const groups = new Map<string, Row[]>();
  for (const r of parsed.rows) {
    const key = r.sku.toUpperCase();
    const first = seen.get(key);
    if (first !== undefined) {
      result.errors.push({ line: r.line, message: `sku ${r.sku} repeats line ${first}` });
      continue;
    }
    seen.set(key, r.line);
    const g = r.group ? `g:${r.group.toLowerCase()}` : `s:${key}`;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }

  try {
    repo.transaction(() => {
      for (const rows of groups.values()) {
        try {
          repo.transaction(() => applyGroup(repo, shopId, rows, opts.currency, result));
        } catch (e) {
          if (!(e instanceof CatalogValidationError || e instanceof SkuTakenError)) throw e;
          const message = e instanceof CatalogValidationError ? e.issues.join('; ') : e.message;
          result.errors.push({ line: rows[0]!.line, message: rows.length > 1 ? `${message} (group starting at this line)` : message });
        }
      }
      result.errors.sort((a, b) => a.line - b.line);
      result.applied = !opts.dryRun && result.errors.length === 0;
      if (!result.applied) throw new Rollback(result);
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return result;
}

function applyGroup(repo: CatalogRepository, shopId: string, rows: Row[], currency: string, out: ImportResult): void {
  const fail = (m: string): never => {
    throw new CatalogValidationError([m]);
  };
  const existing = rows.map((r) => repo.findVariantBySku(shopId, r.sku));
  const productIds = new Set(existing.filter(Boolean).map((v) => v!.productId));
  if (productIds.size > 1) fail('skus of one group belong to different existing products');

  // Product-level fields must not disagree inside a group.
  const pick = <K extends 'name' | 'description' | 'priceMinor'>(k: K): Row[K] => {
    const vals = new Set(rows.map((r) => r[k]).filter((v) => v !== undefined));
    if (vals.size > 1) fail(`rows of one group disagree on ${k}; use variant_price for per-variant prices`);
    return rows.find((r) => r[k] !== undefined)?.[k];
  };
  const name = pick('name');
  const description = pick('description');
  const priceMinor = pick('priceMinor');

  if (productIds.size === 1) {
    const productId = [...productIds][0]!;
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (priceMinor !== undefined) patch.priceMinor = priceMinor;
    const before = repo.getProduct(shopId, productId)!.product;
    if (Object.keys(patch).some((k) => (before as Record<string, unknown>)[k] !== patch[k])) {
      repo.updateProduct(shopId, productId, patch);
      out.updated.products++;
    }
    rows.forEach((r, i) => {
      const v = existing[i];
      if (v) {
        const vp: Record<string, unknown> = {};
        if (r.options) vp.options = r.options;
        if (r.stock !== undefined) vp.stock = r.stock;
        if (r.active !== undefined) vp.active = r.active;
        if (r.variantPriceMinor !== undefined) vp.priceMinor = r.variantPriceMinor;
        const changed = Object.keys(vp).some((k) => JSON.stringify((v as Record<string, unknown>)[k]) !== JSON.stringify(vp[k]));
        if (changed) {
          repo.updateVariant(shopId, productId, v.id, vp);
          out.updated.variants++;
        }
      } else {
        repo.addVariant(shopId, productId, { sku: r.sku, options: r.options ?? {}, priceMinor: r.variantPriceMinor ?? null, stock: r.stock ?? 0, active: r.active ?? true });
        out.created.variants++;
      }
    });
    return;
  }

  if (name === undefined) fail('name is required for a new product');
  if (priceMinor === undefined) fail('price is required for a new product');
  repo.createProduct(shopId, {
    name: name!,
    description: description ?? '',
    priceMinor: priceMinor!,
    currency,
    variants: rows.map((r) => ({ sku: r.sku, options: r.options ?? {}, priceMinor: r.variantPriceMinor ?? null, stock: r.stock ?? 0, active: r.active ?? true })),
  });
  out.created.products++;
  out.created.variants += rows.length;
}
