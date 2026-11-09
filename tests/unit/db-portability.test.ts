import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { orderedId } from '../../packages/database/src/ids';

const ROOT = path.resolve(__dirname, '../..');
const PKG = 'packages/database/src';
/** The only files allowed to know which database is underneath (D47). */
const DIALECT_FILES = new Set(['db.ts', 'dialect.ts', 'schema.ts']);

const tsFiles = (dir: string): string[] =>
  readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(dir, f));
const hits = (files: string[], patterns: RegExp[]) =>
  files.flatMap((f) => {
    const text = readFileSync(path.join(ROOT, f), 'utf8');
    return patterns.filter((p) => p.test(text)).map((p) => `${f}: ${p.source}`);
  });

const SQLITE_ONLY = [
  /better-sqlite3/,
  /sqlite-core/,
  /\browid\b/,
  /json_extract/,
  /julianday/,
  /strftime/,
  /SQLITE_[A-Z]/,
  /\b(?:handle|h)\.raw\b/,
  /\.prepare\(/,
  /\bactive = 1\b/,
];
const repositories = readdirSync(path.join(ROOT, PKG))
  .filter((f) => f.endsWith('.ts') && !DIALECT_FILES.has(f))
  .map((f) => path.join(PKG, f));
const callers = [...tsFiles('apps/api/src'), ...tsFiles('scripts')];

describe('PostgreSQL readiness (D47)', () => {
  it('keeps SQLite-specific code in the dialect files', () => {
    expect(hits([...repositories, ...callers], SQLITE_ONLY)).toEqual([]);
  });

  it('keeps transactions and sync repository variants inside the database package', () => {
    expect(hits(callers, [/\.db\.transaction\(/, /\bhandle\.transaction\(/, /\.\w+Tx\(/])).toEqual([]);
  });

  it('keeps repository bodies synchronous, so a repository call stays atomic', () => {
    expect(
      hits(
        repositories.filter((f) => !f.endsWith('credentials.ts')),
        [/\bawait\b/],
      ),
    ).toEqual([]);
  });
});

describe('orderedId', () => {
  it('sorts in creation order and stays unique inside one millisecond', () => {
    const ids = Array.from({ length: 20_000 }, () => orderedId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is a valid UUIDv7', () => {
    expect(orderedId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
