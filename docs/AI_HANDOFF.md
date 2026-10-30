# AI Handoff

Updated: 2026-10-30T20:50:17Z
Base commit: 0e471c20de426c9829f8d4b9c9924680c06f135a
Branch: main
Working tree: clean (excluding this handoff, which this save modifies). Nothing pushed.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop sales assistant. Official Instagram and website chat ingest into shop tables and call `SalesAgent.trigger`; replies pass the guard and `services/shop-sender.ts`. Instagram (`instagram-official`) lives in `apps/api/src/services/instagram*.ts` and `routes/instagram.ts`; persistence lives in `packages/database`. Outbound HTTP uses `createEgress`; provider secrets use `CredentialVault`. Browser adapter is frozen/off by default. Direction and acceptance: `docs/PROJECT_CONTEXT.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md`.

## Implemented state

F1–F12 and P1 exist: shops/auth/catalog/conversations/agent/orders/takeover/stats/chat/dashboard/CSV, encrypted credentials, Unified login, signed webhooks, dedupe/echo adoption, Send API/window enforcement and polling intake. P2–P7 and D16 auto-pause remain unbuilt.

Committed this session (`edf1b06`): webhook/connect hardening. Explicit subscription success, atomic channel+token save, reserved connecting accounts, 503 with rollback on internal ingest failure, poll cursors retained on failed batches and reset on account switch, UTF-8 safe handshake compare, redacted query names. Four new test files cover it.

Decision D30 (`0e471c2`): development uses polling as the Instagram intake path until Meta delivers real webhooks. Webhook code stays enabled. Polling costs are listed in `docs/LIMITATIONS.md`: latency of one interval plus LLM time, one Graph call per shop per interval, only 10 conversations × 25 messages visible, no durable queue, non-message events invisible, possible duplicates if webhooks later work alongside polling. Multi-shop rollout is blocked on webhooks or a polling redesign.

## Decisions and environment

Node >=22 (dev 24), pnpm, TypeScript, Fastify, SQLite/Drizzle. D29 uses Facebook Unified login, `graph.facebook.com`, API default `v26.0`. Required variables: `HEPSON_MASTER_KEY`, `HEPSON_META_APP_ID`, `HEPSON_META_APP_SECRET`, `HEPSON_META_CONFIG_ID`, `HEPSON_META_VERIFY_TOKEN`, `HEPSON_PUBLIC_URL`, `HEPSON_DASHBOARD_URL`. `HEPSON_INSTAGRAM_POLL_SECONDS` code default is 0 (off); the owner's machine sets 10.

Machine setup: `~/.config/hepson/run-api.sh` loads `.env`, `api.env`, `tunnel.env`; logs in `~/.config/hepson/api.log`. Cloudflare quick tunnel changes URL on every restart; update `HEPSON_PUBLIC_URL` in `tunnel.env`, then the Meta webhook callback (`/webhooks/instagram`) and OAuth redirect (`/public/instagram/callback`), then reconnect Instagram in the dashboard. Dashboard dev: `pnpm dev:dashboard`, port 5174. API listens on 8787. At save time the tunnel, API and dashboard from this session were still running. Avoid repository-wide formatting. Schema exports must be tables.

## Validation

2026-10-30 (this session): `pnpm typecheck` passed before commit. `pnpm test` was not re-run; the last recorded result is 346 passed, 27 files, taken after the final code change, which is unchanged since. Browser suite and dashboard build were not run (last recorded 2026-10-29: 23 passed; build succeeded).

Live evidence (this session): polling stored each test DM exactly once and deduped on the next run. Two transient `instagram poll failed` network errors recovered on the next cycle. An unsigned POST through the tunnel reached the route and returned 401. Meta reports the account subscribed to `messages` and the app-level `instagram` subscription active with the current callback. The token is a valid SYSTEM_USER with `instagram_manage_messages`.

## Known issues and uncertainties

Meta sends no `POST /webhooks/instagram` for real DMs, including from a tester account, with a Live app. Root cause unknown and assumed Meta-side; not confirmed. Unchecked on the Meta side: sender's accepted tester role, the Instagram-product webhook step in the dashboard, Standard vs Advanced Access. Poll message ids equalling webhook `mid`s is unverified. No durable dispatch queue across crashes. An uncertain-send echo may create a duplicate human row; Instagram-app replies do not auto-pause AI. Live 24-hour window, revocation and profile behavior unverified. Older logs may contain secrets; losing the master key requires reconnecting shops.

## Next actions

1. Optional: file a Meta developer support report (app `29057664423897614`, account `17841454455089561`, DM timestamps from `api.log`). Acceptance: one real `POST /webhooks/instagram` in the log.
2. Continue development on polling. Verify revocation, 24-hour window and real echo IDs; decide D16.
3. If webhooks start working: drop polling to 60–120 seconds and test poll/webhook duplicates.
4. Run `pnpm test` and `pnpm test:browser`, then resume P2 per `docs/ROADMAP.md`.
