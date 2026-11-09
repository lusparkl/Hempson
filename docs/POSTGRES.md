# Moving to PostgreSQL

Status: not started. Hepson launches on SQLite and no PostgreSQL driver is installed. This file is the plan for the move and the list of what is already prepared (D47).

Nothing here has been run against a real PostgreSQL server, including the hand-written SQL. Treat the query rewrites as designed for PostgreSQL, not proven on it.

## Already prepared

- Every repository method that touches the database returns a Promise, and `apps/api`, `scripts` and tests await it. Callers should not need to change.
- All SQL differences sit in `packages/database/src/db.ts`, `dialect.ts` and `schema.ts`. `tests/unit/db-portability.test.ts` enforces this.
- Hand-written queries use bound `sql` templates, `case when` instead of summing booleans, `= true` instead of `= 1`, and quoted camelCase aliases.
- Append-only tables break timestamp ties by `orderedId` (UUIDv7), not `rowid`.
- Atomic steps that span repositories live in `packages/database`, not in API code.
- Dispatch of an inbound message runs after its insert commits, so no transaction is held open during it.

## Steps

1. Add `pg` and switch `drizzle.config.ts` to `dialect: 'postgresql'`.
2. Convert `schema.ts` to `pgTable`: `integer(..., { mode: 'boolean' })` becomes `boolean`, `text(..., { mode: 'json' })` becomes `jsonb`, `blob` becomes `bytea`. Fix the partial index `active = 1` to `active = true`.
3. Generate a new baseline migration chain into a separate folder. Do not port the SQLite migrations; `0016` uses `strftime`.
4. Rewrite `db.ts` around a connection pool. `DbHandle.transaction` becomes async and passes a transaction client to its callback.
5. Rewrite `dialect.ts`:
   - `queryRows` and `queryRow` call `db.execute` and read `.rows`.
   - `isUniqueViolation` checks code `23505`.
   - `jsonFirst` becomes `(column::jsonb ->> 0)`.
   - `secondsBetween` becomes `extract(epoch from (to::timestamptz - from::timestamptz))`.
   - Import `alias` from `drizzle-orm/pg-core`.
6. Make repository bodies async, inside `packages/database` only:
   - Replace `.get()` with `(await q)[0]`, `.all()` with `await q`, and `.run()` with `await q`.
   - Replace `.run().changes` with `rowCount`, or use `.returning()`.
   - Make `*Tx` methods async and pass the transaction client through them. Inside a transaction every query must use that client, not `this.db`.
   - Remove the "no await" rule from `tests/unit/db-portability.test.ts`.
7. Set `pg` type parsers for `int8` and `numeric`, or wrap the values in `Number()`. `count(*)` and `sum()` return strings otherwise.
8. Replace `backupDb` and the `pnpm backup` script with `pg_dump` or managed backups.
9. Make the test suite run against PostgreSQL. Tests that use `handle.raw` need rewriting.
10. Write and rehearse the data copy from SQLite, including JSON columns and `0`/`1` booleans. Plan a write freeze for the cut-over.

## Behaviour that SQLite hides

SQLite runs one writer at a time, so several patterns are safe today and will not be on PostgreSQL at READ COMMITTED.

| Where | Pattern | Fix on PostgreSQL |
| --- | --- | --- |
| `ConversationRepository.insertMessage` | `max(seq) + 1` | Lock the conversation row (`for update`) or use a counter column |
| `OrderRepository.createDraft` | `max(number) + 1` per shop | Lock the shop row or use a per-shop counter |
| Transactions that read then write, such as order and payment status moves | Check, then update | `select ... for update`, or put the expected state in the `where` clause |
| Upsert-style "find, else insert" | Two steps | `on conflict`, or retry on a unique violation |
| Queries with no `order by` | SQLite usually returns rowid order | Add an explicit `order by` wherever order is shown or used |
| `asc`/`desc` on nullable columns | SQLite sorts NULLs first ascending, PostgreSQL last | Keep ordering on `x is not null` first, or use `nulls first` |
| In-memory state: rate limits, demo limits, connection guards, agent queues | One process only | Needed as soon as there is more than one API instance, even on one database. Move to shared storage |

Timestamps can stay as ISO-8601 `text` for the first move. They sort correctly because every writer uses `toISOString()`. Moving them to `timestamptz` is a separate, later change.
