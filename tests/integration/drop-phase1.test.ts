import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { ApiKeyRepository, MIGRATIONS_DIR, openDb, runMigrations } from '@hepson/database';

describe('migration 0017 (Phase 1 connector removed, D41)', () => {
  it('keeps admin keys, drops account-scoped keys and every connector table', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hepson-mig-'));
    try {
      // Migrations folder up to 0016, as before the upgrade.
      const old = path.join(dir, 'migrations');
      mkdirSync(path.join(old, 'meta'), { recursive: true });
      const before = (name: string) => Number(name.slice(0, 4)) < 17;
      for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql') && before(f)) copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(old, f));
      const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
      writeFileSync(path.join(old, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter((e) => before(e.tag)) }));
      const h = openDb(path.join(dir, 'db.sqlite'));
      migrate(h.db, { migrationsFolder: old });
      const at = '2026-10-01T10:00:00.000Z';
      const run = (sql: string, ...v: unknown[]) => h.raw.prepare(sql).run(...v);
      const hash = (k: string) => createHash('sha256').update(k).digest('hex');
      run(`insert into shops (id, name, slug, created_at, updated_at) values ('s1', 'S1', 's-one', ?, ?)`, at, at);
      run(`insert into store_accounts (id, label, connector_type, shop_id, created_at, updated_at) values ('acc', 'A', 'mock', 's1', ?, ?)`, at, at);
      run(
        `insert into api_keys (id, account_id, name, hashed_key, created_at) values ('k-admin', null, 'admin', ?, ?), ('k-acc', 'acc', 'scoped', ?, ?)`,
        hash('hep_admin'),
        at,
        hash('hep_scoped'),
        at,
      );
      run(`insert into conversations (id, account_id, participants, title, last_observed_at) values ('c', 'acc', '[]', 'T', ?)`, at);
      run(
        `insert into messages (id, account_id, conversation_id, fingerprint, direction, attachments, observed_at, seq, delivery_status) values ('m', 'acc', 'c', 'f', 'incoming', '[]', ?, 1, 'received')`,
        at,
      );
      run(
        `insert into outbox (id, account_id, conversation_id, idempotency_key, body, body_hash, status, created_at, updated_at) values ('o', 'acc', 'c', 'k', 'b', 'h', 'sent', ?, ?)`,
        at,
        at,
      );
      run(`insert into events (id, account_id, type, payload, occurred_at, sequence) values ('e', 'acc', 'message.received', '{}', ?, 1)`, at);
      run(`insert into connector_state (account_id) values ('acc')`);

      runMigrations(h);
      const tables = (h.raw.prepare(`select name from sqlite_master where type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name);
      for (const t of ['store_accounts', 'conversations', 'messages', 'outbox', 'events', 'connector_state']) expect(tables).not.toContain(t);
      expect(h.raw.prepare(`select id, name from api_keys`).all()).toEqual([{ id: 'k-admin', name: 'admin' }]);
      const keys = new ApiKeyRepository(h);
      expect(keys.find('hep_admin')?.id).toBe('k-admin');
      expect(keys.find('hep_scoped')).toBeUndefined();
      expect(h.raw.prepare(`select id from shops`).all()).toEqual([{ id: 's1' }]);
      h.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
