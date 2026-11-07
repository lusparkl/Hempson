import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors';
import {
  CatalogNotFoundError,
  CatalogValidationError,
  InsufficientStockError,
  SkuTakenError,
  effectivePrice,
  importCatalogCsv,
  importCatalogTable,
  type AuthRepository,
  type CatalogRepository,
  type ProductWithVariants,
  type ShopRepository,
  type VariantRow,
} from '@hepson/database';
import { SheetsError, fetchSheetCsv, parseSheetUrl } from '../services/google-sheets';
import { XlsxReadError, readXlsxFirstSheet } from '../services/xlsx';
import { route } from './define';
import { makeRequireRole } from './shops';

const shopP = z.object({ shopId: z.uuid() });
const productP = z.object({ shopId: z.uuid(), productId: z.uuid() });
const variantP = z.object({ shopId: z.uuid(), productId: z.uuid(), variantId: z.uuid() });

// Bodies are validated in depth by the repository; routes only fix the shape.
const variantBody = z.strictObject({
  sku: z.string(),
  options: z.record(z.string(), z.string()).optional(),
  priceMinor: z.number().nullable().optional(),
  stock: z.number().optional(),
  active: z.boolean().optional(),
});
const createBody = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  priceMinor: z.number(),
  currency: z.string().optional(),
  active: z.boolean().optional(),
  media: z.array(z.string()).optional(),
  sku: z.string().optional(),
  stock: z.number().optional(),
  variants: z.array(variantBody).optional(),
});
const updateBody = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  priceMinor: z.number().optional(),
  currency: z.string().optional(),
  active: z.boolean().optional(),
  media: z.array(z.string()).optional(),
});
const variantPatchBody = z.strictObject({
  sku: z.string().optional(),
  options: z.record(z.string(), z.string()).optional(),
  priceMinor: z.number().nullable().optional(),
  active: z.boolean().optional(),
});
const stockBody = z.union([z.strictObject({ delta: z.number() }), z.strictObject({ set: z.number() })]);
const importBody = z.strictObject({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().optional() });
const sheetBody = z.strictObject({ url: z.string().min(1).max(1000), dryRun: z.boolean().optional() });
/** An .xlsx file as base64 (at most 5 MB decoded). */
const MAX_XLSX_BYTES = 5_000_000;
const xlsxBody = z.strictObject({
  file: z
    .base64()
    .min(1)
    .max(Math.ceil(MAX_XLSX_BYTES / 3) * 4),
  dryRun: z.boolean().optional(),
});
/** Owner-facing reasons an .xlsx file could not be read (P8). */
const XLSX_ERRORS: Record<XlsxReadError['kind'], string> = {
  not_xlsx: 'This is not an .xlsx file: save the workbook as Excel Workbook (.xlsx) or CSV',
  too_large: 'The file is too large: at most 5000 rows, split it',
  unsupported: 'This Excel format is not supported (binary .xlsb, encrypted or very large workbook): save it as .xlsx or CSV',
  no_sheet: 'The workbook has no worksheet',
};
/** Owner-facing reasons a Google Sheet could not be read (P8). */
const SHEET_ERRORS: Record<SheetsError['kind'], string> = {
  not_public: 'The sheet is not shared: set "Anyone with the link" to Viewer in Google Sheets',
  not_found: 'No such sheet or tab: check the link',
  too_large: 'The sheet is larger than 2 MB as CSV: split it',
  redirect_refused: 'Google answered from an unexpected address; the sheet was not read',
  unavailable: 'Google Sheets is not reachable, try again',
};
const listQuery = z.object({
  q: z.string().max(200).optional(),
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const variantView = (p: ProductWithVariants['product'], v: VariantRow) => ({
  variantId: v.id,
  sku: v.sku,
  options: v.options,
  priceMinor: effectivePrice(p, v),
  priceOverrideMinor: v.priceMinor,
  stock: v.stock,
  active: v.active,
  updatedAt: v.updatedAt,
});
const productView = ({ product: p, variants }: ProductWithVariants) => ({
  productId: p.id,
  name: p.name,
  description: p.description,
  priceMinor: p.priceMinor,
  currency: p.currency,
  active: p.active,
  media: p.media,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  variants: variants.map((v) => variantView(p, v)),
});

function translate(e: unknown): never {
  if (e instanceof CatalogValidationError) throw new ApiError('VALIDATION_ERROR', e.message);
  if (e instanceof SkuTakenError) throw new ApiError('VALIDATION_ERROR', e.message);
  if (e instanceof InsufficientStockError) throw new ApiError('VALIDATION_ERROR', e.message);
  if (e instanceof CatalogNotFoundError) throw new ApiError('NOT_FOUND', e.message);
  throw e;
}

/** Owner: create/edit products and variants. Any member: read, and change stock. */
export function registerCatalogRoutes(
  app: FastifyInstance,
  deps: { shops: ShopRepository; auth: AuthRepository; catalog: CatalogRepository; egress: typeof fetch; onCatalogChange?: () => void },
) {
  const { shops, auth, catalog, egress } = deps;
  /** P9: products or their images changed; the photo index catches up in the background. */
  const changed = <T>(v: T): T => {
    deps.onCatalogChange?.();
    return v;
  };
  const requireRole = makeRequireRole(shops, auth);
  const base = '/v1/shops/:shopId/products';

  route(app, {
    method: 'POST',
    url: base,
    summary: 'Create a product with variants (or a default variant from sku/stock) (owner)',
    tag: 'catalog',
    auth: 'user',
    params: shopP,
    body: createBody,
    status: 201,
    handler: ({ req, params, body }) => {
      const { shop } = requireRole(req, params.shopId, 'owner');
      try {
        return changed(productView(catalog.createProduct(shop.id, { currency: shop.defaultCurrency, ...body })));
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'GET',
    url: base,
    summary: 'Search/list products with variants (any member)',
    tag: 'catalog',
    auth: 'user',
    params: shopP,
    query: listQuery,
    handler: ({ req, params, query }) => {
      requireRole(req, params.shopId, 'manager');
      const r = catalog.listProducts(params.shopId, {
        q: query.q,
        active: query.active === undefined ? undefined : query.active === 'true',
        limit: query.limit,
        offset: query.offset,
      });
      return { total: r.total, items: r.items.map(productView) };
    },
  });

  route(app, {
    method: 'GET',
    url: `${base}/:productId`,
    summary: 'Get a product (any member)',
    tag: 'catalog',
    auth: 'user',
    params: productP,
    handler: ({ req, params }) => {
      requireRole(req, params.shopId, 'manager');
      const p = catalog.getProduct(params.shopId, params.productId);
      if (!p) throw new ApiError('NOT_FOUND', 'product not found');
      return productView(p);
    },
  });

  route(app, {
    method: 'PATCH',
    url: `${base}/:productId`,
    summary: 'Update product fields; deactivate instead of deleting (owner)',
    tag: 'catalog',
    auth: 'user',
    params: productP,
    body: updateBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'owner');
      try {
        return changed(productView(catalog.updateProduct(params.shopId, params.productId, body)));
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'POST',
    url: `${base}/:productId/variants`,
    summary: 'Add a variant (owner)',
    tag: 'catalog',
    auth: 'user',
    params: productP,
    body: variantBody,
    status: 201,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'owner');
      try {
        const v = catalog.addVariant(params.shopId, params.productId, body);
        return variantView(catalog.getProduct(params.shopId, params.productId)!.product, v);
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'PATCH',
    url: `${base}/:productId/variants/:variantId`,
    summary: 'Update variant sku/options/price/active (owner); stock has its own endpoint',
    tag: 'catalog',
    auth: 'user',
    params: variantP,
    body: variantPatchBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'owner');
      try {
        const v = catalog.updateVariant(params.shopId, params.productId, params.variantId, body);
        return variantView(catalog.getProduct(params.shopId, params.productId)!.product, v);
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'POST',
    url: `${base}/:productId/variants/:variantId/stock`,
    summary: 'Change stock: {delta} (atomic, never below 0) or {set} (any member)',
    tag: 'catalog',
    auth: 'user',
    params: variantP,
    body: stockBody,
    handler: ({ req, params, body }) => {
      requireRole(req, params.shopId, 'manager');
      try {
        const v =
          'delta' in body
            ? catalog.adjustStock(params.shopId, params.productId, params.variantId, body.delta)
            : catalog.updateVariant(params.shopId, params.productId, params.variantId, { stock: body.set });
        return variantView(catalog.getProduct(params.shopId, params.productId)!.product, v);
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'POST',
    url: `${base}/import`,
    summary: 'Import products from CSV text, upserting by SKU; dryRun (default true) reports without writing (owner)',
    tag: 'catalog',
    auth: 'user',
    params: shopP,
    body: importBody,
    bodyLimit: 2_500_000,
    handler: ({ req, params, body }) => {
      const { shop } = requireRole(req, params.shopId, 'owner');
      try {
        return changed(importCatalogCsv(catalog, shop.id, body.csv, { dryRun: body.dryRun ?? true, currency: shop.defaultCurrency }));
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'POST',
    url: `${base}/import-xlsx`,
    summary: 'Import products from the first worksheet of an .xlsx file (base64), with the same columns and rules as CSV; dryRun (default true) reports without writing (owner)',
    tag: 'catalog',
    auth: 'user',
    params: shopP,
    body: xlsxBody,
    bodyLimit: 7_000_000,
    handler: ({ req, params, body }) => {
      const { shop } = requireRole(req, params.shopId, 'owner');
      const file = Buffer.from(body.file, 'base64');
      if (file.length > MAX_XLSX_BYTES) throw new ApiError('VALIDATION_ERROR', 'The file is larger than 5 MB: split it');
      let table: ReturnType<typeof readXlsxFirstSheet>;
      try {
        table = readXlsxFirstSheet(file);
      } catch (e) {
        if (e instanceof XlsxReadError) throw new ApiError('VALIDATION_ERROR', XLSX_ERRORS[e.kind]);
        throw e;
      }
      try {
        return changed(importCatalogTable(catalog, shop.id, table, { dryRun: body.dryRun ?? true, currency: shop.defaultCurrency }));
      } catch (e) {
        translate(e);
      }
    },
  });

  route(app, {
    method: 'POST',
    url: `${base}/import-sheet`,
    summary: 'Import products from a Google Sheet shared by link, through the same CSV importer; dryRun (default true) reports without writing (owner)',
    tag: 'catalog',
    auth: 'user',
    params: shopP,
    body: sheetBody,
    handler: async ({ req, params, body }) => {
      const { shop } = requireRole(req, params.shopId, 'owner');
      const ref = parseSheetUrl(body.url);
      if (!ref) throw new ApiError('VALIDATION_ERROR', 'Paste a Google Sheets link (https://docs.google.com/spreadsheets/d/...)');
      let csv: string;
      try {
        csv = await fetchSheetCsv(egress, ref, { maxBytes: 2_000_000 });
      } catch (e) {
        if (e instanceof SheetsError) throw new ApiError(e.kind === 'unavailable' ? 'TEMPORARY_FAILURE' : 'VALIDATION_ERROR', SHEET_ERRORS[e.kind]);
        throw e;
      }
      if (!csv.trim()) throw new ApiError('VALIDATION_ERROR', 'The sheet is empty');
      try {
        return changed(importCatalogCsv(catalog, shop.id, csv, { dryRun: body.dryRun ?? true, currency: shop.defaultCurrency }));
      } catch (e) {
        translate(e);
      }
    },
  });
}
