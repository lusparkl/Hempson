import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './db';

/**
 * Every SQL construct or driver behaviour that differs between SQLite and PostgreSQL lives here, in `db.ts` or in
 * `schema.ts` (D47, docs/POSTGRES.md). `tests/unit/db-portability.test.ts` fails if one appears anywhere else.
 */
export { alias } from 'drizzle-orm/sqlite-core';

/** Hand-written queries. Quote camelCase aliases (`as "shopId"`): PostgreSQL folds unquoted names to lowercase. */
export const queryRows = <T>(db: Db, q: SQL): T[] => db.all<T>(q);
export const queryRow = <T>(db: Db, q: SQL): T | undefined => db.get<T>(q);
export const execute = (db: Db, q: SQL): void => {
  db.run(q);
};

export const isUniqueViolation = (e: unknown): boolean => (e as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE';

/** First element of a JSON array column, as text; null when the array is empty. */
export const jsonFirst = (column: SQL): SQL => sql`json_extract(${column}, '$[0]')`;

/** Seconds from one ISO-8601 text timestamp to another. */
export const secondsBetween = (from: SQL, to: SQL): SQL => sql`((julianday(${to}) - julianday(${from})) * 86400)`;
