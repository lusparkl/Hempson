import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db, DbHandle } from './db';
import * as t from './schema';

export type ApiKeyRow = typeof t.apiKeys.$inferSelect;

const now = () => new Date().toISOString();
const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');

/** Operator (admin) API keys (`hep_…`). Only the SHA-256 hash is stored. */
export class ApiKeyRepository {
  private db: Db;
  constructor(handle: DbHandle) {
    this.db = handle.db;
  }

  /** Returns the plaintext key ONCE. */
  create(name: string): { key: string; row: ApiKeyRow } {
    const key = `hep_${randomBytes(32).toString('base64url')}`;
    const row: ApiKeyRow = { id: randomUUID(), name, hashedKey: hashKey(key), createdAt: now(), revokedAt: null };
    this.db.insert(t.apiKeys).values(row).run();
    return { key, row };
  }

  find(key: string): ApiKeyRow | undefined {
    return this.db
      .select()
      .from(t.apiKeys)
      .where(and(eq(t.apiKeys.hashedKey, hashKey(key)), isNull(t.apiKeys.revokedAt)))
      .get();
  }

  revoke(id: string): void {
    this.db.update(t.apiKeys).set({ revokedAt: now() }).where(eq(t.apiKeys.id, id)).run();
  }
}
