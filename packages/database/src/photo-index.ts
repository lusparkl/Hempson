import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbHandle } from './db';
import { jsonFirst, queryRow, queryRows } from './dialect';
import * as t from './schema';

export type PhotoIndexRow = typeof t.productPhotoIndex.$inferSelect;
/** A product whose main image has no current index entry. */
export type PhotoIndexTask = { shopId: string; productId: string; imageUrl: string };
export type PhotoIndexEntry = { productId: string; vector: Float32Array };
export type PhotoIndexStatus = { withPhoto: number; indexed: number; failed: number; pending: number };

/** Only web images are indexed: the vision provider fetches them itself, so Hepson never requests an owner-supplied URL. */
const WEB_IMAGE = /^https?:\/\/[^\s]+$/i;
const MAIN_IMAGE = jsonFirst(sql`p.media`);

export function encodeVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
export function decodeVector(b: Buffer): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

/**
 * P9 photo search index (D42). Every method takes `shopId` first or returns rows carrying it. Internal: no authorization.
 * "Current" means the entry's image is the product's `media[0]` and it was built with the given model id.
 */
export class PhotoIndexRepository {
  readonly db: Db;
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }

  /** Active products with a web main image and no current entry (failed entries for the same image and model are not retried). */
  async pending(model: string, limit: number, shopId?: string): Promise<PhotoIndexTask[]> {
    const rows = queryRows<PhotoIndexTask>(
      this.db,
      sql`select p.shop_id as "shopId", p.id as "productId", ${MAIN_IMAGE} as "imageUrl"
           from products p
           left join product_photo_index i on i.product_id = p.id and i.image_url = ${MAIN_IMAGE} and i.model = ${model}
          where p.active = true and ${MAIN_IMAGE} is not null and i.product_id is null ${shopId ? sql`and p.shop_id = ${shopId}` : sql``}
          order by p.updated_at
          limit ${limit}`,
    );
    return rows.filter((r) => typeof r.imageUrl === 'string' && WEB_IMAGE.test(r.imageUrl) && r.imageUrl.length <= 2048);
  }

  async saveReady(task: PhotoIndexTask, model: string, description: string, vector: Float32Array): Promise<void> {
    this.upsert({ ...task, model, status: 'ready', description: description.slice(0, 2000), embedding: encodeVector(vector), error: null, indexedAt: this.clock().toISOString() });
  }

  async saveFailed(task: PhotoIndexTask, model: string, error: string): Promise<void> {
    this.upsert({ ...task, model, status: 'failed', description: '', embedding: null, error: error.slice(0, 64), indexedAt: this.clock().toISOString() });
  }

  private upsert(row: PhotoIndexRow): void {
    const { productId, ...rest } = row;
    this.db.insert(t.productPhotoIndex).values(row).onConflictDoUpdate({ target: t.productPhotoIndex.productId, set: rest }).run();
  }

  /** Current ready entries of active products in this shop. */
  async entries(shopId: string, model: string): Promise<PhotoIndexEntry[]> {
    const rows = queryRows<{ productId: string; embedding: Buffer }>(
      this.db,
      sql`select i.product_id as "productId", i.embedding as "embedding"
           from product_photo_index i join products p on p.id = i.product_id and p.shop_id = i.shop_id
          where i.shop_id = ${shopId} and i.status = 'ready' and i.model = ${model} and p.active = true and i.image_url = ${MAIN_IMAGE}`,
    );
    return rows.map((r) => ({ productId: r.productId, vector: decodeVector(r.embedding) }));
  }

  async status(shopId: string, model: string): Promise<PhotoIndexStatus> {
    const r = queryRow<{ withPhoto: number; indexed: number; failed: number }>(
      this.db,
      sql`select count(*) as "withPhoto",
                coalesce(sum(case when i.status = 'ready' then 1 else 0 end), 0) as "indexed",
                coalesce(sum(case when i.status = 'failed' then 1 else 0 end), 0) as "failed"
           from products p
           left join product_photo_index i on i.product_id = p.id and i.image_url = ${MAIN_IMAGE} and i.model = ${model}
          where p.shop_id = ${shopId} and p.active = true and ${MAIN_IMAGE} is not null`,
    )!;
    return { ...r, pending: r.withPhoto - r.indexed - r.failed };
  }

  /** Lets failed images be tried again (owner action after fixing a link). */
  async clearFailed(shopId: string): Promise<number> {
    return this.db
      .delete(t.productPhotoIndex)
      .where(and(eq(t.productPhotoIndex.shopId, shopId), eq(t.productPhotoIndex.status, 'failed')))
      .run().changes;
  }

  async get(shopId: string, productId: string): Promise<PhotoIndexRow | undefined> {
    return this.db
      .select()
      .from(t.productPhotoIndex)
      .where(and(eq(t.productPhotoIndex.shopId, shopId), eq(t.productPhotoIndex.productId, productId)))
      .get();
  }
}
