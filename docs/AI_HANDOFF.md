# AI Handoff

Updated: 2026-10-30T12:45:00Z
Base commit: 0cd1ae6a645dbb3e4836ab37ea6cc07584dc4a13
Branch: main (local only, not pushed)
Working tree: **P1 is uncommitted** (about 40 paths; auth layer rewritten for Unified login on 2026-10-30, D29). New: `packages/database/src/{credentials,credential-kinds,instagram}.ts`, migration `0009_instagram_official` + snapshot, `apps/api/src/services/{egress,instagram,instagram-graph}.ts`, `apps/api/src/routes/instagram.ts`, `scripts/{rewrap-credentials,gen-master-key}.ts`, tests `unit/{credentials,egress}`, `integration/instagram`. Modified: `server.ts`, `config.ts`, `sales-agent.ts`, `shop-sender.ts`, `routes/{accounts,conversations}.ts`, `notifier.ts`, `connector-service.ts`, `errors.ts`, `conversations.ts`, `schema.ts`, dashboard `Settings.tsx`, `.env.example`, `package.json`, `docs/*`, `AGENTS.md`, test helpers. Snapshot only; the hash cannot prove it current. F1-F12 and pivot docs are committed (P0 done).

## Purpose and architecture
Hepson: Ukrainian-first multi-shop AI sales assistant over Instagram DMs, website chat (Telegram next). Boundaries and invariants: `AGENTS.md`; vision `docs/PROJECT_CONTEXT.md`; order/acceptance `docs/ROADMAP.md`; decisions D1-D28 `docs/DECISIONS.md`. Direction D22: official APIs only; `packages/instagram-browser` frozen, off by default.
Inbound paths into shop tables: browser/mock = connector event -> `ChannelBridge`; website = `WebChatService`; **Instagram official (Unified login, D29) = signed webhook -> `InstagramService.handleWebhook` -> `ingestMessage` (channel `instagram-official`)**. Web and Instagram call `SalesAgent.trigger` (one run per message). Reply: LLM tool loop -> reply guard -> `deliverPending` (`services/shop-sender.ts`: connector / `instagram` / `internal`). All outbound HTTP via `createEgress` (`services/egress.ts`). Secrets: `CredentialVault` (AES-256-GCM envelope, no read-back, `withSecret` only).

## Implemented state
- Phase 1 connector: complete, live-verified 2026-10-28, frozen.
- F1-F12: shops, auth, catalog, conversations, AI agent, order drafts, takeover + Telegram notifier, stats, website chat, dashboard, CSV import.
- **P1, built and mock-tested, never run against Meta:** vault + keyring + `pnpm gen-master-key` / `rewrap-credentials`; egress allow-list (OpenAI, Telegram, Instagram clients on it); owner connect flow (Facebook Login for Business `config_id` dialog, single-use `state`, code -> system-user token on `graph.facebook.com`, `/me/assigned_instagram_accounts` (exactly one), `subscribed_apps`); `GET|POST /webhooks/instagram` (verify token, HMAC over raw body before parsing; routes exist only if app id, secret and verify token are set); dedupe by `mid`; echo adoption; Send API with 24 h window check, `uncertain` never retried, token rejection -> `needs_reconnect` + notification; agent escalates if the window closed; human reply refused before recording; no token refresh (the 6-hourly job is `expireDue`, flags only a reported `expires_in`); dashboard Instagram card; `HEPSON_ENABLE_BROWSER_ADAPTER` (default false).
- Decisions (in `DECISIONS.md`): direct ingest into shop tables, not `MessagingAdapter` (D23 amendment); D16 auto-pause not built (echo semantics unverified).

## Decisions and environment
Node 24, pnpm, SQLite + Drizzle. New env names: `HEPSON_MASTER_KEY[_VERSION]` (+ `_PREVIOUS[_VERSION]` while rotating; process env only), `HEPSON_META_APP_ID`/`SECRET` (the Meta app's own, not an Instagram app id), `HEPSON_META_CONFIG_ID`, `HEPSON_META_VERIFY_TOKEN`, `HEPSON_META_API_VERSION` (default `v26.0`), `HEPSON_DASHBOARD_URL`, `HEPSON_ENABLE_BROWSER_ADAPTER`, `HEPSON_EGRESS_EXTRA_HOSTS`. Commands: `pnpm migrate`, `start:api`, `dev:dashboard`, `build`, `openapi`, `backup`, `test`, `test:browser`, `typecheck`. `buildApp` test hooks: `keyring`, `fetchImpl`, `logStream`. Pitfalls: all `schema.ts` exports must be tables (enum constants live in `credential-kinds.ts`); do not run `pnpm format` repo-wide; delete `.playwright-mcp/` if created.

## Validation
2026-10-30 (after D29 + polling): `pnpm typecheck` clean; `pnpm test` 304 pass (23 files); dashboard build OK; `pnpm test:browser` not re-run. 2026-10-29: `pnpm test:browser` 23 pass; `pnpm test:browser` 23 pass (3 files, 210 s); dashboard build OK. Mock-Graph tests cover connect, replay, bad signature, closed window, revoked token, uncertain, refresh, rotation, log/API secret leakage, egress denial. Not verified: anything against real Meta, Telegram or live OpenAI; the dashboard Instagram card beyond build; `rewrap-credentials` CLI beyond a 0-row run.

## Known issues and uncertainties
- **Meta sends no real message webhooks (open).** Full evidence and ideas in `docs/LIMITATIONS.md`. Workaround in use: `HEPSON_INSTAGRAM_POLL_SECONDS=10` (Conversations API poller, D29). First live round trip (2026-10-30): connect via Unified login, DM -> poll -> one AI reply -> echo adopted, no duplicate (checked in DB and log; the reply appearing in the Instagram app was reported, not seen by the agent).
- Local setup: `~/.config/hepson/run-api.sh` loads `.env` + `api.env` (master key) + `tunnel.env` (public URL); `cloudflared` quick tunnel (URL changes on restart; update Meta redirect/callback). `HEPSON_DATA_DIR=~` is now expanded by `loadConfig`. Test owner/shop/products live in `~/.hepson/hepson.db` (credentials in `.env` as `TEST_OWNER_*`).
- Meta endpoint shapes, scopes, error codes/subcodes, API version, `#_` code suffix, Development-mode webhook delivery, echo `mid` == Send API `message_id`: from documentation memory.
- `uncertain` send followed by echo may leave a duplicate `human` row; app-typed replies do not pause the AI.
- Webhook returns 200 after the signature check even if one event failed (logged by code only).
- Master key is an env var, no KMS; lost key = every shop reconnects; no runbook script.
- Not built: Telegram channel (P2), policies tool (P3), Nova Poshta (P4), payments (P5), customer notices (P6), quotas (P7).

## Next actions
1. Owner: review and commit P1 (suggested split: database + migration + vault; egress + instagram service/routes; tests; dashboard + docs). Never commit without the owner's word.
2. Owner live check (connect, one DM and one reply done via polling; webhooks, window, revoke and D16 still open): Meta app with Unified login (app owned by a business portfolio, configuration with `instagram_basic` + `instagram_manage_messages`, its id as `HEPSON_META_CONFIG_ID`), own account as tester, HTTPS tunnel as `HEPSON_PUBLIC_URL`, master key and Meta env vars set; webhook `<public>/webhooks/instagram`, redirect `<public>/public/instagram/callback`. Connect, DM, confirm one reply and one correct echo, try after 24 h, revoke token. Capture real payloads, fix `instagram-graph.ts`/`instagram.ts`, replace fixtures, then decide D16.
3. Next feature: P2 Telegram customer channel (`docs/ROADMAP.md`); live check needs an owner test bot.
