# AI Handoff

Updated: 2026-11-02T15:52:44Z
Base commit: 31ff0d534648366555d4b5b377fe058c18f6b915
Branch: main
Working tree: uncommitted redesign — modified `apps/dashboard/src/**`, `apps/website/src/{animations.ts,components/Layout.tsx,entry-client.tsx,i18n/uk.ts,i18n/ru.ts,pages/Home.tsx,pages/Pricing.tsx,styles.css}`, `apps/website/public/favicon.svg`, `docs/DECISIONS.md`, `docs/ROADMAP.md`, `tsconfig.json`; untracked `packages/ui/`, `apps/dashboard/src/{ui.tsx,views/Overview.tsx}`, `apps/website/public/logos/`, `apps/website/src/components/Faq.tsx`.

This is a snapshot: the uncommitted content cannot be proven current by the commit hash alone. `main` equals `origin/main` at `31ff0d5`.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop AI sales assistant on official APIs only (D22). Channels (official Instagram, Telegram bot per shop, website chat) write into shop tables and call `SalesAgent.trigger`; replies pass `agent/guard.ts` and leave via `services/shop-sender.ts`. Secrets only in `CredentialVault`; outbound HTTP only via `createEgress`. Code map: `docs/OVERVIEW.md`. Decisions D1–D38 in `docs/DECISIONS.md`. Roadmap (P-series, W1, P10) in `docs/ROADMAP.md`.

Frontends: `apps/dashboard` (shop-owner cabinet), `apps/website` (prerendered marketing site, `uk` at `/`, `ru` under `/ru/`, D37). Shared design system: `packages/ui/src` (D38) — `styles.css` (tokens + component classes), `components.tsx`, `icons.ts` (inlined lucide-static@0.460.0), `embeds/` (HeroEmbed, HowEmbed, CtaBg, LoginFlow, `motion.ts`). No `package.json`; apps import it by relative path.

## Implemented state

F1–F12 and P1–P8 built; P9 suggestions built (D36); photo search, forwarded posts, storefront not built. W1 website structure built (D37).

**Redesign (this session, uncommitted, D38)** from the Claude Design project "Hepson Dashboard v3" / "Hepson Home v2":
- Dashboard: split login with LoginFlow art; sidebar shell (shop switcher incl. "+ Новий магазин", nav counts, usage meter, user block); top bar with portal page actions (`HeaderActions` in `ui.tsx`), AI status, bell; pages Overview (new), Inbox (list, thread with inline order drafts, customer side panel), Orders (status-group tabs, list + detail, all previous actions kept, Excel export menu), Catalog (stepper stock, import and new-product drawers), Stats, Settings (tabs channels/AI/rules/ship/team). Page kept in URL hash.
- Website: home, header (design's three anchors) and footer (keeps page/legal links, contacts, language switcher) per design; home copy restructured in `d.pages.home` (uk + ru); FAQ moved to `components/Faq.tsx` (pricing only); logos in `public/logos/`; `header.mobile-menu` and `trust.guard` slots removed. Inner pages only reuse tokens.
- Missing backend pieces recorded as **P10** with UI placeholders and `P10` code comments: last-message preview, unread state, customer notes, customer-level profile, notification centre, per-day stats series (customers/orders/revenue/human replies), sequential order numbers, self-hosted fonts, inner-page design.

## Decisions and environment

- Node >=22 (dev 24), pnpm, TypeScript strict, Fastify, SQLite/Drizzle, React/Vite.
- Commands: `pnpm typecheck`, `pnpm test`, `pnpm build` (console + dashboard), `pnpm build:website`, `pnpm dev:dashboard` (5174, proxies `/v1` to 8787), `pnpm dev:website` (5175). Real API: `~/.config/hepson/run-api.sh`.
- Variables (names only): `HEPSON_MASTER_KEY`, `HEPSON_PUBLIC_URL`, `HEPSON_DATA_DIR`, `VITE_SITE_URL`, `VITE_DASHBOARD_URL`, plus those in D32–D37.
- Geist font loads from Google Fonts (design system spec); conflicts with D37 privacy stance until self-hosted (P10).

## Validation

Run 2026-11-02 on the uncommitted tree:
- `pnpm typecheck`: 0 errors. `pnpm test`: 484 passed in 39 files (incl. 8 website tests).
- `pnpm build` and `pnpm build:website` (24 pages): passed.
- Playwright screenshots against an isolated API (scratch `HEPSON_DATA_DIR`, no private env, seeded shop/products/web-chat chats): all six dashboard pages at 1440 and 390 px, home at 1280 and 390, `/ru/pricing/`; no console errors, no horizontal scroll.

Not checked: Orders page with real order data, Settings actions against real providers, real-LLM conversation, `pnpm test:browser`, inner website pages visually.

## Known issues and uncertainties

- pnpm commands first fail an install with `ERR_PNPM_IGNORED_BUILDS`; scripts still run; lockfile lacks `apps/website`.
- Prettier not clean on several files; not run on new files.
- Chromium's `scrollIntoView` returns a Promise: React effects must use block bodies.
- Not live-checked: Monobank, Nova Poshta, Google Sheets redirect, Instagram webhooks.

## Next actions

1. Review the redesign in the browser (`pnpm dev:dashboard` + API), then commit (e.g. `feat(ui): design system, dashboard v3 and home v2`).
2. P10 items in `docs/ROADMAP.md`, starting with last-message preview and per-day stats; each removes its placeholder and `P10` comment, with tests.
3. Self-host Geist; design inner website pages; fill `src/site.ts`; lawyer review; hosting.
4. Fix pnpm build approval so the lockfile includes `apps/website`.
5. P9 photo search after the model choice.
