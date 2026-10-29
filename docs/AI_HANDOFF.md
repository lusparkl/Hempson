# AI Handoff

Updated: 2026-10-29 (pivot docs session; code state unchanged since 19:48Z)
Base commit: ba67d376a5c1ffaa92ae38b968824e8aa2c01877
Branch: main (local only, not pushed)
Working tree: Phase 2 Features 1-12 are uncommitted (about 84 changed/untracked paths): migrations `0001`-`0008`, `packages/database/src/{shops,auth,catalog,catalog-import,conversations,agent,orders,stats,webchat}.ts`, `apps/api/src/{auth/,agent/,widget/,services/{channel-bridge,notifier,shop-sender,web-chat,rate-limit}.ts,routes/{auth,shops,catalog,conversations,channels,ai,orders,stats,web-chat}.ts}`, hooks in `connector-service.ts`/`event-bus.ts`/`store.ts`/`server.ts`/`config.ts`/`schema.ts`/`db.ts`, `scripts/backup.ts`, `apps/dashboard/`, tests, docs. This is a snapshot; the commit hash alone cannot prove it is current.

## Pivot status (read first)
2026-10-29: product direction changed (D22): compete with NovaSale on official APIs only; Instagram via the official API (D23), payments via the shop's own acquiring (D24), order state machine (D25), per-shop autonomy (D26), Telegram customer channel (D27), encrypted per-shop credentials (D28). The browser adapter is frozen. **The pivot is planned only. No pivot code, migration or dependency exists; nothing has run against Meta, Telegram, Nova Poshta, Monobank or WayForPay.** The only changes this session are docs (`DECISIONS.md`, `ROADMAP.md`, `PROJECT_CONTEXT.md`, `LIMITATIONS.md`, `FUTURE_META_ADAPTER.md`, `OVERVIEW.md`, `AGENTS.md`, this file). Roadmap is the P-series in `docs/ROADMAP.md`; **next session is P1** (`instagram-official` adapter, credential store, egress guard, browser adapter off by default). P0 (owner commits F1-F12) should happen before P1 code.

## Purpose and architecture
Hepson = Ukrainian-first multi-shop SaaS AI sales assistant on top of a Phase 1 Instagram Direct connector (authenticated local HTTP API, REST + SSE, `/v1`). Boundaries and invariants: `AGENTS.md`. Vision/rules: `docs/PROJECT_CONTEXT.md`. Feature order and acceptance: `docs/ROADMAP.md`. Decisions D1-D28: `docs/DECISIONS.md`. Reader's guide plus proposed next features: `docs/OVERVIEW.md`. This file is the only state record.

Instagram DOM knowledge lives only in `packages/instagram-browser/src/{selectors,parsers}.ts`. Phase 1 `conversations`/`messages` are account-scoped: do not alter them. Phase 2 tables are shop-scoped. Data flow: Instagram path = connector `message.received` -> `SalesAgent` (`EventBus.subscribeAll`); website path = visitor POST -> `WebChatService` -> `SalesAgent.triggerInternal`. Then OpenAI tool loop -> reply guard -> `deliverPending` (`services/shop-sender.ts`: connector queue, or `internal` for website) -> bridge adopts the pending row.

## Implemented state
- **Phase 1**: complete, live-verified 2026-10-28 on one authorized account (`docs/MANUAL_INSTAGRAM_TEST.md`).
- **F1-F5**: shops, auth (`hsu_` sessions, owner/manager), catalog, shop conversations/messages, `ChannelBridge`.
- **F6/F7**: AI agent (tools, reply guard, escalations), order drafts with human approval.
- **F8**: per-conversation AI pause, human reply, `TelegramNotifier` (D16, D17). **F9**: stats (D18). **F10**: website chat (D19). **F11**: `apps/dashboard` (React/Vite, port 5174; D20).
- **F12** (D21): `POST /v1/shops/:shopId/products/import` (owner; `{csv, dryRun}`, dry run default, 2 MB, 5000 rows; upsert by SKU, one transaction, line-numbered errors; `RouteDef.bodyLimit` added). Dashboard import card in the Catalog tab. Hardening: `GET /ready`, `no-store`/`nosniff`/`no-referrer` headers on `/v1/*` and `/public/*`, `AuthRepository.purgeDeadSessions` (6-hourly timer), `pnpm backup` (`backupDb` in `db.ts`, mode 0600, excludes `profiles/`). CSV only: Excel and URL feeds deliberately not built (SSRF, parser dependency).

## Decisions and environment
Node 24, pnpm, SQLite + Drizzle, data dir `HEPSON_DATA_DIR` (default `~/.hepson`). Env names: `OPENAI_API_KEY`, `HEPSON_OPENAI_MODEL` (tested `gpt-5.4-nano`), `HEPSON_OPENAI_BASE_URL`, `HEPSON_TELEGRAM_BOT_TOKEN`, `HEPSON_TELEGRAM_API_BASE_URL`, `HEPSON_PUBLIC_URL`, `HEPSON_TRUST_PROXY`, `HEPSON_WEBCHAT_*` limits, `HEPSON_SESSION_TTL_DAYS`, `HEPSON_ALLOW_REGISTRATION`. Agent starts only with key + model; nothing auto-loads `.env`. Commands: `pnpm migrate` (dev DB: run to reach `0008_web_chat`), `pnpm bootstrap-key`, `pnpm start:api`, `pnpm dev:dashboard`, `pnpm build`, `pnpm openapi`, `pnpm backup`, `pnpm test`, `pnpm test:browser`, `pnpm typecheck`. Pitfalls: no named inner functions in `page.evaluate*` callbacks; never `pkill -f` a pattern in your own command line; prettier is not clean repo-wide (do not run `pnpm format` blindly); Playwright MCP can only upload files under the project root and writes `.playwright-mcp/` (untracked, delete it).

## Validation
2026-10-29, after F12: `pnpm typecheck` clean; `pnpm test` 254 pass (20 files); `pnpm test:browser` 23 pass (3 files, 212 s), so Phase 1 suites are confirmed after the shared-code changes. Manual: dashboard import (upload `;` CSV, preview, apply) worked in real Chromium against API + Vite; `pnpm backup` produced a valid 0600 file. Not verified: agent/bridge/human reply on real Instagram, live Telegram, live OpenAI after F8-F11, website chat behind a real proxy/domain, dashboard automated UI tests.

## Known issues and uncertainties
- Agent and bridge never run against real Instagram. Account data wipe + resync duplicates messages in the shop. Mirrored `occurred_at` is observation time; stats count by ingest time (D18).
- Human reply has no idempotency key. Out-of-band human replies in the Instagram app do not auto-pause the AI (D16).
- Website chat: polling, no CAPTCHA, in-memory rate limits per node, `Origin` is not authentication (D19). Tokens live in `localStorage`. Auth lacks email verification, reset, 2FA.
- CSV import sets stock from the file and can overwrite changes made since the export (D21).
- Not built: policies/FAQ tool, media understanding, per-shop model, cost limits, customer notice after draft decision, stock reservation, product delete, Telegram test route, dashboard variants/edit/roles/Instagram onboarding, backup rotation/restore script.
- Phase 1 untested live: media, groups, non-English UI, second account, `uncertain` send, concurrent sends, reboot. Web-UI automation may breach Instagram's terms (`docs/LIMITATIONS.md`).

## Next actions
1. Owner: commit F1-F12 in several commits (P0). Never commit or push without the owner saying so.
2. Owner, before P1: create a Meta app (Instagram API with Instagram Login), add the owner's professional account as tester, prepare a public HTTPS tunnel, choose a master key (kept outside the repo and outside backups). Owner decisions so far: first pilot payment provider Monobank; unpaid order expires after 24 h with one reminder; P1 adapter shape = webhook-fed `MessagingAdapter` + `ChannelBridge` (P1 may amend D23 after reading the code); returned COD parcels go `returning` then `returned` with restock on confirmation, and refusals per customer disable COD (D25). Owner has no Meta app, tunnel or master key yet: they are prerequisites for the P1 live check, not for the P1 code and mock tests.
3. P1 session (scope in `docs/ROADMAP.md`): foundations (D28 store, egress helper, env), connect flow, webhook, Send API with 24-hour window, mapping into shop tables, browser adapter flag, D16 echo check. Then P2 onward in order.
4. Phase 1 live checks and backlog are frozen (D22); the browser adapter gets no new work.
