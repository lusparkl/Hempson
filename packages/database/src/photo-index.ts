import { and, eq } from 'drizzle-orm';
import type { Db, DbHandle } from './db';
import * as t from './schema';

export type PhotoIndexRow = typeof t.productPhotoIndex.$inferSelect;
/** A product whose main image has no current index entry. */
export type PhotoIndexTask = { shopId: string; productId: string; imageUrl: string };
export type PhotoIndexEntry = { productId: string; vector: Float32Array };
export type PhotoIndexStatus = { withPhoto: number; indexed: number; failed: number; pending: number };

/** Only web images are indexed: the vision provider fetches them itself, so Hepson never requests an owner-supplied URL. */
const WEB_IMAGE = /^https?:\/\/[^\s]+$/i;

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
  pending(model: string, limit: number, shopId?: string): PhotoIndexTask[] {
    const rows = this.handle.raw
      .prepare(
        `select p.shop_id shopId, p.id productId, json_extract(p.media, '$[0]') imageUrl
           from products p
           left join product_photo_index i on i.product_id = p.id and i.image_url = json_extract(p.media, '$[0]') and i.model = ?
          where p.active = 1 and json_extract(p.media, '$[0]') is not null and i.product_id is null ${shopId ? 'and p.shop_id = ?' : ''}
          order by p.updated_at
          limit ?`,
      )
      .all(...(shopId ? [model, shopId, limit] : [model, limit])) as PhotoIndexTask[];
    return rows.filter((r) => typeof r.imageUrl === 'string' && WEB_IMAGE.test(r.imageUrl) && r.imageUrl.length <= 2048);
  }

  saveReady(task: PhotoIndexTask, model: string, description: string, vector: Float32Array): void {
    this.upsert({ ...task, model, status: 'ready', description: description.slice(0, 2000), embedding: encodeVector(vector), error: null, indexedAt: this.clock().toISOString() });
  }

  saveFailed(task: PhotoIndexTask, model: string, error: string): void {
    this.upsert({ ...task, model, status: 'failed', description: '', embedding: null, error: error.slice(0, 64), indexedAt: this.clock().toISOString() });
  }

  private upsert(row: PhotoIndexRow): void {
    const { productId, ...rest } = row;
    this.db.insert(t.productPhotoIndex).values(row).onConflictDoUpdate({ target: t.productPhotoIndex.productId, set: rest }).run();
  }

  /** Current ready entries of active products in this shop. */
  entries(shopId: string, model: string): PhotoIndexEntry[] {
    const rows = this.handle.raw
      .prepare(
        `select i.product_id productId, i.embedding embedding
           from product_photo_index i join products p on p.id = i.product_id and p.shop_id = i.shop_id
          where i.shop_id = ? and i.status = 'ready' and i.model = ? and p.active = 1 and i.image_url = json_extract(p.media, '$[0]')`,
      )
      .all(shopId, model) as Array<{ productId: string; embedding: Buffer }>;
    return rows.map((r) => ({ productId: r.productId, vector: decodeVector(r.embedding) }));
  }

  status(shopId: string, model: string): PhotoIndexStatus {
    const r = this.handle.raw
      .prepare(
        `select count(*) as "withPhoto",
                coalesce(sum(i.status = 'ready'), 0) as "indexed",
                coalesce(sum(i.status = 'failed'), 0) as "failed"
           from products p
           left join product_photo_index i on i.product_id = p.id and i.image_url = json_extract(p.media, '$[0]') and i.model = ?
          where p.shop_id = ? and p.active = 1 and json_extract(p.media, '$[0]') is not null`,
      )
      .get(model, shopId) as { withPhoto: number; indexed: number; failed: number };
    return { ...r, pending: r.withPhoto - r.indexed - r.failed };
  }

  /** Lets failed images be tried again (owner action after fixing a link). */
  clearFailed(shopId: string): number {
    return this.db
      .delete(t.productPhotoIndex)
      .where(and(eq(t.productPhotoIndex.shopId, shopId), eq(t.productPhotoIndex.status, 'failed')))
      .run().changes;
  }

  get(shopId: string, productId: string): PhotoIndexRow | undefined {
    return this.db
      .select()
      .from(t.productPhotoIndex)
      .where(and(eq(t.productPhotoIndex.shopId, shopId), eq(t.productPhotoIndex.productId, productId)))
      .get();
  }
}
