# AI Handoff

Updated: 2026-10-30T16:47:23Z
Base commit: b2b379dd248486231e0e22042afe7ab859838510
Branch: main
Working tree: modified `apps/api/src/{routes/instagram.ts,server.ts,services/instagram.ts,services/instagram-graph.ts}`, `packages/database/src/instagram.ts`, `tests/integration/instagram.test.ts`, `docs/{DECISIONS,LIMITATIONS}.md`; untracked `tests/integration/instagram-{connect-race,http,ingest-recovery}.test.ts`, `tests/unit/instagram-graph.test.ts`. Nothing staged. Uncommitted content is a snapshot; the commit hash alone cannot prove it current.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop sales assistant. Official Instagram and website chat ingest into shop tables and call `SalesAgent.trigger`; replies pass the guard and `services/shop-sender.ts`. Instagram (`instagram-official`) lives in `apps/api/src/services/instagram*.ts` and `routes/instagram.ts`; persistence lives in `packages/database`. Outbound HTTP uses `createEgress`; provider secrets use `CredentialVault`. Browser adapter is frozen/off by default. Project direction and acceptance: `docs/PROJECT_CONTEXT.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md`.

## Implemented state

F1–F12 and P1 exist: shops/auth/catalog/conversations/agent/orders/takeover/stats/chat/dashboard/CSV, encrypted credentials, Unified login, signed webhooks, dedupe/echo adoption, Send API/window enforcement and polling fallback. P2–P7 and D16 auto-pause remain unbuilt.

Current uncommitted webhook fixes:
- Require explicit subscription success and check account pagination. Save channel/token atomically; failed replacements preserve existing connections.
- Reserve connecting accounts so early deliveries return 503. Disconnect cancels pending callbacks; overlapping shop operations are refused and canceled subscriptions receive best-effort cleanup.
- Return 503 on internal ingestion failures while continuing other events. Roll back insertion on synchronous dispatch failure; retries dedupe successful messages. Permanently invalid events remain acknowledged.
- Poll from connection time, retain cursors on failed batches, include equal timestamps, reset on account switches, and discard stale responses after connection changes.
- Compare handshake secrets by UTF-8 byte length and redact encoded OAuth/verify-token query names.

## Decisions and environment

Node >=22 (development 24), pnpm, TypeScript, Fastify, SQLite/Drizzle. D29 uses Facebook Unified login, `graph.facebook.com`, API default `v26.0`. Required settings: `HEPSON_MASTER_KEY`, `HEPSON_META_APP_ID`, `HEPSON_META_APP_SECRET`, `HEPSON_META_CONFIG_ID`, `HEPSON_META_VERIFY_TOKEN`, `HEPSON_PUBLIC_URL`; dashboard destination: `HEPSON_DASHBOARD_URL`. `HEPSON_INSTAGRAM_POLL_SECONDS=0` disables polling. No migration/dependency change in this fix.

Earlier machine setup, not rechecked: `~/.config/hepson/run-api.sh` supplies env files; `~/.hepson/hepson.db`; cloudflared quick tunnel. Tunnel restarts require updating Meta callback/redirect URLs. API does not load `.env` itself. Avoid repository-wide formatting. Schema exports must be tables.

## Validation

2026-10-30, after final code changes: `pnpm test` **346 passed, 27 files**; `pnpm typecheck` and `git diff --check` passed. Four new test files passed Prettier. Failure regressions were reproduced before fixes. No live Meta, browser, or build checks this fix session. Earlier handoff records dashboard build success and browser suite 23 passed on 2026-10-29; neither validates these changes.

Earlier live evidence: Unified login and polling stored one DM, produced one AI reply, and adopted its echo. Reply visibility was owner-reported. Real webhook delivery was not verified.

## Known issues and uncertainties

Real DMs previously produced no POST despite registered app/account subscriptions, working handshake and dashboard Test delivery. Root cause remains unresolved; fixes do not establish live recovery (`docs/LIMITATIONS.md`). Polling remains limited to recent messages; equality between poll IDs and webhook `mid`s is unverified. Dispatch has no durable queue across crashes. An uncertain-send echo may create a duplicate human row; Instagram-app replies do not auto-pause AI. Live window/revocation/profile behavior remains unverified. Older logs may contain secrets; losing the master key requires reconnecting shops.

## Next actions

1. Review uncommitted changes; commit only when requested.
2. Test an authorized real DM against the updated server. Confirm `POST /webhooks/instagram`, one stored message/run/reply, and echo dedupe; distinguish webhook delivery from polling. If absent, inspect Meta delivery diagnostics/tester access and tunnel configuration.
3. Verify revocation, 24-hour window and real echo IDs; decide D16. Once webhook delivery works, consider polling at 60–120 seconds.
4. Re-run `pnpm test:browser`; then resume P2 per roadmap.
