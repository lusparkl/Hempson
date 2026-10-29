import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;
export type DbHandle = { db: Db; raw: Database.Database; close(): void };

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** `file` may be ':memory:' for tests. */
export function openDb(file: string): DbHandle {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  const db = drizzle(raw, { schema });
  return { db, raw, close: () => raw.close() };
}

export function runMigrations(h: DbHandle): void {
  migrate(h.db, { migrationsFolder: MIGRATIONS_DIR });
}

/** Consistent online copy of the database (safe while the API runs; includes WAL content). */
export async function backupDb(h: DbHandle, destFile: string): Promise<void> {
  mkdirSync(path.dirname(destFile), { recursive: true, mode: 0o700 });
  await h.raw.backup(destFile);
  chmodSync(destFile, 0o600);
}
