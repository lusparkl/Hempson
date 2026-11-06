# AI Handoff

Updated: 2026-11-04T13:00:55Z
Base commit: 87349cd9d302c9cc07d83c0616b1b55dea76a949
Branch: feat/redesign (pushed; `origin/main` and local `main` also at `87349cd`)
Working tree: clean

This is a snapshot: the uncommitted content cannot be proven current by the commit hash alone.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop AI sales assistant on official APIs only (D22). Channels (official Instagram, Telegram bot per shop, website chat) write into shop tables and call `SalesAgent.trigger`; replies pass `agent/guard.ts` and leave via `services/shop-sender.ts`. Secrets only in `CredentialVault`; outbound HTTP only via `createEgress`. Code map: `docs/OVERVIEW.md`. Decisions D1–D40 in `docs/DECISIONS.md`; roadmap in `docs/ROADMAP.md`.

Frontends: `apps/dashboard` (shop-owner cabinet, port 5174, proxies API 8787), `apps/website` (prerendered marketing site, Ukrainian only, D37/D39). Shared design system `packages/ui/src` (D38), imported by relative path; Geist/Geist Mono self-hosted in `packages/ui/src/fonts/` (OFL).

Design source: Claude Design project `22d3597b-e8e9-47f8-b07a-5136fec514a2` (Dashboard v3, Home v2, Hepson Site, Footer, CTA).

## Implemented state

- P0–P9 per ROADMAP (several live checks TODO). W1 website: structure, home, inner pages, footer, CTA committed (`f73a3a6`).
- P10 done (`87349cd`, D40):
  - Inbox/overview last-message preview ("ШІ:"/"Ви:", attachments).
  - Per-member unread (`conversation_reads`, forward-only seq marker); nav count polls `/conversations/unread-count`; thread marks read while visible; human reply marks read.
  - Customer note (≤2000, shop-private, never sent to AI) and profile card (`GET /customers/:id`: phone, city, orders count/placed/totals).
  - Notification centre: `packages/database/src/notifications.ts`, `routes/notification-feed.ts` (`GET /notification-feed`, `POST /notification-feed/seen`), `apps/dashboard/src/Notifications.tsx`. Kinds: handoff, order_new, payment_problem, ttn_problem; 30-day window; one `seenAt` per member. Separate from `/notifications` (Telegram chat config).
  - Stats `daily` is dense (every UTC day) with `newCustomers`, `outgoingHuman`, `approved`, `revenueMinor` (shop default currency only).
  - Per-shop order numbers `order_drafts.number` (unique per shop); `orderLabel()` used in dashboard, Excel, Telegram, customer notices, payment texts, agent tool.
  - Migration `0016_p10_parity.sql` backfills numbers by creation order and marks existing history read for current members.

## Decisions and environment

- Node >=22 (dev 24), pnpm, TypeScript strict, Fastify 5, Zod 4, SQLite/Drizzle, React/Vite, Vitest.
- Commands: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm build:website`, `pnpm dev:api`, `pnpm dev:dashboard`, `pnpm dev:website` (5175), `pnpm exec drizzle-kit generate --name X`.
- Variables (names only): `HEPSON_MASTER_KEY`, `HEPSON_PUBLIC_URL`, `HEPSON_DATA_DIR`, `VITE_SITE_URL`, `VITE_DASHBOARD_URL`, plus D32–D37.
- Communicate with the user in English, regardless of site language.

## Validation

2026-11-04 on the tree committed as `87349cd`: `pnpm typecheck` 0 errors; `pnpm test` 490 passed (40 files; new `tests/integration/p10-parity.test.ts` covers features, cross-shop isolation, migration backfill); `pnpm build` and `pnpm build:website` (12 pages) OK, no Google Fonts in output. Playwright manual pass on scratch data dir with demo data: overview, bell, inbox (note save + reload), analytics, orders at 1440 and 390 px; no horizontal scroll, no console errors, zero external font requests.

Not checked: `pnpm test:browser`, real Telegram / Nova Poshta / Monobank / Instagram.

## Known issues and uncertainties

- Payment/TTN problem may reappear unread if the order row is updated later (feed keys on `updated_at`; trade-off in D40).
- ROADMAP W1 row still says "inner-page design … TODO" — stale.
- Header hides "Увійти" ≤400px (design shows it).
- pnpm lockfile lacks `apps/website`; install warns `ERR_PNPM_IGNORED_BUILDS`.
- Prettier not clean on some files (pre-existing: `uk.ts`, website `styles.css`, `icons.ts`, `Home.tsx`, others).

## Next actions

1. Fix ROADMAP W1 row (inner pages done 2026-11-02/04).
2. Owner fills `apps/website/src/site.ts` (contacts, legal entity, prices); lawyer reviews legal texts; About story/team.
3. Fix pnpm lockfile for `apps/website`; show "Увійти" ≤400px.
4. Live checks: P2 disconnect, P4 Nova Poshta, P5 Monobank test token; WayForPay.
5. P9 remainder (photo search, forwarded posts, storefront) per D36; P8 XLSX import.
