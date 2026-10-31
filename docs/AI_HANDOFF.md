# AI Handoff

Updated: 2026-10-31T19:39:27Z
Base commit: 36624ddb0058de9b9c1ad361c981a4dec6f42a1e
Branch: main
Working tree: uncommitted docs/config cleanup. Staged deletions: `docs/PLAN.md`, `docs/FUTURE_META_ADAPTER.md`, `docs/CHECKLIST.md`, `docs/AI_HANDOFF.template.md`, `example-client.ts`. Modified: `README.md`, `AGENTS.md`, `.env.example`, `package.json`, `tsconfig.json`, `docs/{API,LIMITATIONS,MANUAL_INSTAGRAM_TEST,OVERVIEW,PROJECT_CONTEXT,ROADMAP}.md`. This is a snapshot; the commit hash alone cannot prove it current. Nothing pushed.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop AI sales assistant. Official Instagram (`instagram-official`, webhooks or polling) and website chat ingest into shop tables and call `SalesAgent.trigger`. Replies pass the guard and `services/shop-sender.ts`. Instagram lives in `apps/api/src/services/instagram*.ts` and `routes/instagram.ts`; persistence lives in `packages/database`. Outbound HTTP goes through `createEgress`; provider secrets go through `CredentialVault`. The Phase 1 browser adapter and `/v1/accounts` API are frozen and off by default. Code map: `docs/OVERVIEW.md`. Direction: `docs/PROJECT_CONTEXT.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md` (D1–D30).

## Implemented state

F1–F12 and P1 are built: shops, auth, catalog, conversations, agent, orders, takeover, stats, website chat, dashboard, CSV import, encrypted credentials, Unified login, signed webhooks, dedupe and echo adoption, Send API with window enforcement, and polling intake. P2–P9 and D16 auto-pause are not built.

This session (uncommitted) was cleanup only, with no source logic changes:
- Removed superseded docs and the Phase 1 example client, plus the `pnpm example` script and its tsconfig entry.
- Rewrote `README.md` and `docs/OVERVIEW.md` for the current product.
- Added the shop API route list to `docs/API.md`.
- Marked P1 as partly live-checked in the roadmap, limitations and project context.
- `.env.example` now has defaults commented and the Phase 1 variables grouped.

## Decisions and environment

Node >=22 (dev 24), pnpm, TypeScript, Fastify, SQLite/Drizzle. D29 uses Facebook Unified login on `graph.facebook.com` with the code default API `v26.0`. D30 makes polling the development intake path.

Nothing auto-loads `.env`; `~/.config/hepson/run-api.sh` loads `.env`, `api.env` and `tunnel.env`.
- `.env` (0600) now holds only `OPENAI_API_KEY`, `HEPSON_OPENAI_MODEL`, `HEPSON_META_APP_ID`, `HEPSON_META_APP_SECRET`, `HEPSON_META_CONFIG_ID`, `HEPSON_META_VERIFY_TOKEN`, `HEPSON_INSTAGRAM_POLL_SECONDS` and an empty `HEPSON_TELEGRAM_BOT_TOKEN`.
- `api.env` holds `HEPSON_MASTER_KEY` and `HEPSON_MASTER_KEY_VERSION`.
- `tunnel.env` holds `HEPSON_PUBLIC_URL` and `HEPSON_DASHBOARD_URL`.
- Removed from `.env`: default-valued lines, the dead `HEPSON_INSTAGRAM_REFRESH_WITHIN_DAYS`, the duplicate dashboard URL, and `HEPSON_META_API_VERSION=v23.0`. The next API start therefore uses v26.0.
- Old `.env` backup: `~/.config/hepson/env.backup-2026-10-31`. Test login moved to `~/.config/hepson/test-owner.env`.

The Cloudflare quick tunnel URL changes on every restart. After a restart:
1. Update `HEPSON_PUBLIC_URL` in `tunnel.env`.
2. Update the Meta webhook callback `/webhooks/instagram` and the OAuth redirect `/public/instagram/callback`.
3. Reconnect Instagram in the dashboard.

The dashboard runs on port 5174 and the API on 8787. Avoid repository-wide formatting.

## Validation

2026-10-31, after the cleanup:
- `pnpm typecheck` passed.
- `pnpm test` passed: 346 tests, 27 files.
- `pnpm openapi` regenerated with no diff.
- Effective `loadConfig` before and after the `.env` change differs only in the Meta API version (and the OpenAI base URL now comes from an identical client default).

Not run: `pnpm test:browser` (last 23 passed, 2026-10-29), `pnpm build` (last succeeded 2026-10-29), and any live run on v26.0.

Live evidence from 2026-10-30: polling stored test DMs once and deduped them; the agent replied; the echo was adopted; Meta subscriptions are active.

## Known issues and uncertainties

- Meta sends no real `POST /webhooks/instagram`. Root cause unknown; assumed Meta-side.
- Polling on v26.0 is unverified live.
- Unverified: poll ids equal webhook `mid`s.
- No durable dispatch queue.
- An uncertain-send echo may create a duplicate `human` row.
- Instagram-app replies do not auto-pause the AI.
- Unverified live: 24-hour window, revocation.
- `~/.config/hepson/api.log` may contain secrets. Losing the master key forces shops to reconnect.

## Next actions

1. Review and commit the cleanup (suggested: `docs: clean up stale docs and env example`).
2. Restart the API through `run-api.sh` and confirm one polling cycle succeeds on v26.0. If it fails, restore the `HEPSON_META_API_VERSION` line from the backup.
3. Run `pnpm test:browser` and `pnpm build`.
4. Optional: file a Meta support report (app `29057664423897614`, account `17841454455089561`). Acceptance: one real webhook POST in the log.
5. Start P2 (Telegram customer channel, D27; needs a test bot) per `docs/ROADMAP.md`.
