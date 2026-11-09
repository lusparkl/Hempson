# AI Handoff

Updated: 2026-11-09T10:41:57Z
Base commit: ffe120cdf1603fdbb19afc552737fd9d441e02fa
Branch: main (level with `origin/main`)
Working tree: clean

Uncommitted content, if any appears later, is a snapshot and cannot be proven current by the commit hash alone.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop AI sales assistant on official APIs only (D22). Channels (official Instagram, Telegram bot per shop, website chat) write into shop tables and call `SalesAgent.trigger`; replies pass `agent/guard.ts` and leave via `services/shop-sender.ts`. Secrets only in `CredentialVault`; outbound HTTP only via `createEgress`. Code map: `docs/OVERVIEW.md`, `docs/INVENTORY.md`. Decisions D1–D50 in `docs/DECISIONS.md`; roadmap in `docs/ROADMAP.md`.

Frontends: `apps/dashboard` (port 5174, proxies API 8787), `apps/website` (prerendered, Ukrainian only, D37/D39, port 5175). Shared design system `packages/ui/src` (D38). Website copy is in `apps/website/src/i18n/uk.ts`; owner facts in `apps/website/src/site.ts`.

## Implemented state

- P0–P10 and W1 built per ROADMAP; WayForPay deferred (D44), Monobank only.
- Operator panel (D50, `ffe120c`): dashboard `#operator`, signed in with a `hep_` key held in `sessionStorage`. Routes `/v1/operator/{shops,runs,errors}` and `PUT /v1/operator/shops/:shopId/ai-stop` (`routes/operator.ts`); cross-shop reads in `packages/database/src/operator.ts`. Shows shops, AI runs, errors, channel status and usage (tokens and AI replies, no money). `RecentErrors` (`services/alerts.ts`) keeps the latest 100 error kinds in memory.
- Kill switch (D50): `shop_ai_settings.operator_stopped_at`, separate from the owner's `enabled`. Blocks new runs and the test chat, and ends runs in flight (`skipped`/`OPERATOR_STOPPED`). Customers get nothing and no escalation opens. The owner gets one Telegram notice per stop and per resume (`ai_stopped`, `ai_resumed`), without the operator's reason.
- Operator alerts (D49): off unless `HEPSON_ALERT_TELEGRAM_CHAT_ID` and a bot token are set. `AlertMonitor` takes probes (`services/health-probes.ts`), real provider traffic and events. `scripts/watchdog.ts` (`pnpm watchdog`) must run on another machine to cover a server death.
- Paid-until (D48): `shop_plans.paid_until`, last paid Kyiv date, inclusive; null means no expiry. Set on `PUT /v1/shops/:shopId/plan`. After it only the AI stops. One `plan_expiring` reminder at 3 days or fewer.
- PostgreSQL preparation (D47, `docs/POSTGRES.md`): SQLite remains the only database.
- Earlier: XLSX import (D43); photo search, forwarded posts, storefront `/s/<slug>` (D42); AI playground; website demo `/demo/`, off unless `HEPSON_DEMO` is set (D45); password reset (D46); Team tab; website design sync. About, Security, Contact and legal pages were not re-compared with the design.

## Decisions and environment

- Operator keys now open the plan route and `/v1/operator/*`, widening D41; only those routes read across shops.
- Design placeholders deliberately not copied: plan prices (`PRICING`, undecided), `SITE.contacts`, `SITE.legalEntity`, the FAQ claim about recalculating the month's difference (not built).
- Node >=22 (dev 24), pnpm, TypeScript strict, Fastify 5, Zod 4, SQLite/Drizzle, React/Vite, Vitest, `nodemailer`.
- Commands: `pnpm typecheck`, `pnpm test`, `pnpm test:browser`, `pnpm build`, `pnpm build:website`, `pnpm migrate`, `pnpm dev:api`, `pnpm dev:dashboard`, `pnpm dev:website`, `pnpm watchdog`, `pnpm bootstrap-key`, `pnpm exec drizzle-kit generate --name X`. Nothing auto-loads `.env`.
- Variables (names only): `OPENAI_API_KEY`, `HEPSON_OPENAI_MODEL`, `HEPSON_MASTER_KEY`, `HEPSON_PUBLIC_URL`, `HEPSON_DASHBOARD_URL`, `HEPSON_TRUST_PROXY`, `HEPSON_DATA_DIR`, `HEPSON_DEFAULT_PLAN`, `HEPSON_TELEGRAM_BOT_TOKEN`, `HEPSON_DEMO*`, `HEPSON_SMTP_*`, `HEPSON_PHOTO_SEARCH`, `HEPSON_EGRESS_EXTRA_HOSTS`, `HEPSON_ALERT_TELEGRAM_CHAT_ID`, `HEPSON_ALERT_TELEGRAM_BOT_TOKEN`, `HEPSON_ALERT_CHECK_SECONDS`, `HEPSON_ALERT_REMIND_MINUTES`, `HEPSON_ALERT_DISK_FREE_MB`, `HEPSON_ALERT_URLS`, `HEPSON_WATCHDOG_URL`, `HEPSON_WATCHDOG_SECONDS`, `VITE_SITE_URL`, `VITE_DASHBOARD_URL`, `VITE_API_URL`.
- Communicate with the user in English. Do not suggest save-context.

## Validation

2026-11-09, on `ffe120c`: `pnpm typecheck` 0 errors; `pnpm test` 552 passed (46 files); `pnpm build` passed; `pnpm test:browser` 2 passed; `pnpm build:website` passed, 13 pages. Prettier clean on the main operator files.

Real Chromium against a local API with a scripted model and seeded rows, 1440 and 390 px: wrong key refused, data shown, stop worked, channel badges and reconnect rows correct, no page overflow.

Never run in a browser: the resume button, the owner's "ШІ зупинено" header and Settings alert, the expiry banners, `/s/<slug>`.

Never run for real: Telegram delivery of alerts, expiry or stop/resume notices; a provider outage; open incidents through `/v1/operator/errors` with alerts on (`incidents()` is unit-tested only); PostgreSQL; OpenAI demo replies; an SMTP server; channel rows from real accounts; any real-platform check.

## Known issues and uncertainties

- Kill switch does not stop catalog photo indexing or a tool call already started. Messages received during a stop are not answered after resume. Its owner notice has one attempt and needs a notification chat.
- Panel server errors clear on restart; open incidents appear only with Telegram alerts configured.
- Alert probes for Meta, Monobank and Nova Poshta assume an unauthenticated call gets a non-5xx answer (unverified; a wrong assumption gives false "down" alerts). Alerts do not detect inbound webhooks that silently stop. Nothing watches the watchdog. Pending alerts and open incidents are lost on restart.
- Expiry reminder is lost if the shop has no notification chat or the single send fails. Chats escalated during a pause stay escalated after renewal.
- `/features/` is unlinked but prerendered and in the sitemap. Storefront and dashboard round kopecks: 50.50 shows as `51 ₴`. Home storefront sample shows `hepson.ua/s/linen-home`; domain ownership unknown.
- Demo limits are in memory; the Origin check is not authentication. The privacy page does not mention demo messages going to OpenAI.
- Email deliverability unknown. Photo-search thresholds uncalibrated (D42). Instagram photo download refused until a live capture gives the CDN host. XLSX reader untested on real files (D43).
- Payment/TTN problem may reappear unread after a later order row update (D40).
- Browser profiles under `$HEPSON_DATA_DIR/profiles/` hold Instagram session cookies; delete by hand (D41).
- Prettier not clean on `apps/api/src/routes/auth.ts`, `packages/database/src/auth.ts`, `apps/dashboard/src/api.ts`, `apps/dashboard/src/views/Overview.tsx` (last checked before D50).

## Next actions

1. Deploy `ffe120c` (migration `0022` applies at API start). Create a key with `pnpm bootstrap-key`; accept when `#operator` lists real shops.
2. Stop and resume a test shop with a notification chat; accept when both Telegram notices arrive, the AI stays silent while stopped, and the owner sees "ШІ зупинено".
3. Set `HEPSON_ALERT_TELEGRAM_CHAT_ID` and an https `HEPSON_PUBLIC_URL`, restart; accept when "Hepson API started" arrives from the real bot.
4. Run `pnpm watchdog` on another machine; stop the API and confirm DOWN then RECOVERED. Watch the first day of probes for false alerts.
5. Set `paidUntil` for each paying shop; check expiry banners and both expiry messages.
6. Decide `/features/`; decide plan prices (`apps/website/src/site.ts`, caps equal to server, `tests/unit/website.test.ts`).
7. Configure SMTP and `HEPSON_DASHBOARD_URL`; confirm a reset email.
8. Enable the demo with a spending cap; set `HEPSON_DEMO_ORIGINS`, `VITE_API_URL`.
9. Check `/s/<slug>` at 1440 and 390 px; decide kopeck display.
10. Live checks: P1 webhooks, P2 disconnect, P4 Nova Poshta, P5 Monobank, Google Sheets, Instagram media (`docs/LIMITATIONS.md`).
11. Owner fills `apps/website/src/site.ts`, adds Open Graph image; lawyer reviews legal texts; hosting.
