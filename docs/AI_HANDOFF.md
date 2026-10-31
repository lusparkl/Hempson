# AI Handoff

Updated: 2026-10-31T20:20:52Z
Base commit: f0d1cb4a5ee9fd8c8d53c4836a6e9079fef13c61
Branch: main
Working tree: uncommitted P2 (Telegram customer channel). Modified: `apps/api/src/{server.ts,agent/sales-agent.ts,routes/conversations.ts,services/{notifier,shop-sender}.ts}`, `apps/dashboard/src/views/Settings.tsx`, `packages/database/src/{index,schema}.ts`, `packages/database/src/migrations/meta/_journal.json`, `docs/{API,DECISIONS,LIMITATIONS,OVERVIEW,ROADMAP}.md`, `docs/openapi.json`. New: `apps/api/src/routes/telegram.ts`, `apps/api/src/services/telegram{,-bot}.ts`, `packages/database/src/telegram.ts`, migration `0011_telegram_channel` (+ snapshot), `tests/integration/telegram.test.ts`. The commit hash alone cannot prove this snapshot current. Nothing pushed.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop AI sales assistant. Three customer channels ingest into the shop tables and call `SalesAgent.trigger`:
- Official Instagram (`instagram-official`, webhooks or polling).
- Telegram (`telegram`, one bot per shop, webhook).
- Website chat.

Replies pass the guard, then go out through `services/shop-sender.ts`. `deliverDirect` there is now shared by Instagram and Telegram.

Telegram code:
- `TelegramBotApi` (`services/telegram-bot.ts`): the HTTP client.
- `TelegramService` (`services/telegram.ts`): connect, disconnect, ingest, send.
- `routes/telegram.ts`: `GET|PUT|DELETE /v1/shops/:shopId/telegram` and `POST /webhooks/telegram/:webhookId`.
- `TelegramRepository` (`packages/database/src/telegram.ts`): the `telegram_channels` table.

All outbound HTTP goes through `createEgress`, and shop tokens go through `CredentialVault` (kind `telegram_bot`). The Phase 1 browser adapter is frozen. Code map: `docs/OVERVIEW.md`. Direction: `docs/PROJECT_CONTEXT.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md` (D1–D30; D27 has a P2 implementation note).

## Implemented state

F1–F12, P1 and P2 are built. P3–P9 and D16 auto-pause are not built.

How P2 works:
- **Connect:** the owner pastes the bot token. Hepson calls `getMe`, then `setWebhook` (opaque path, random secret, `allowed_updates: ['message']`, `drop_pending_updates`), then stores the token encrypted.
- **Webhook secret:** stored as sha256 in `webhook_auth_hash`. An unknown path and a wrong secret both get 401.
- **Ingest:** private chats only. Message id is `<chat_id>:<message_id>`, which also dedupes replays.
- **Send outcomes:** 403 = `BOT_BLOCKED` (`failed`). 401/404 = `needs_reconnect` and an owner notification (`channel_issue`, channel `telegram`). 5xx/timeout = `uncertain`, never retried.
- **Dashboard:** new card "Telegram-бот для клієнтів".
- Code does not refuse the operator notifier token as a shop bot.

## Decisions and environment

Node >=22 (dev 24), pnpm, TypeScript, Fastify, SQLite/Drizzle.
- D29: Unified login, Meta API `v26.0`.
- D30: polling is the development intake for Instagram.
- P2 needs an https `HEPSON_PUBLIC_URL` and `HEPSON_MASTER_KEY`.

Nothing auto-loads `.env`. `~/.config/hepson/run-api.sh` loads `.env`, `api.env` and `tunnel.env`; a variable already set in the shell wins over these files.

The live test bot is `@hempson_bot`. Its token is `HEPSON_TELEGRAM_BOT_TOKEN` in `.env`, which is also the operator notifier bot. Using it for the live test was the owner's choice; D27 forbids sharing it in production. The test owner login is in `~/.config/hepson/test-owner.env`, and the test shop is `test-shop`.

Current run (2026-10-31), started by the assistant as background processes:
- A Cloudflare quick tunnel (log: session scratchpad `tunnel.log`).
- The API, started with that URL passed inline.
- `tunnel.env` was NOT updated (editing it was denied) and still has the old URL.
- The bot's webhook points at this tunnel. It breaks when the tunnel stops.

## Validation

2026-10-31:
- `pnpm typecheck` passed.
- `pnpm test` passed: 364 tests, 28 files, 18 of them Telegram tests against a fake Bot API written from Telegram's docs.
- `pnpm openapi` regenerated.

Live P2 run on `@hempson_bot`:
- `getMe` and `setWebhook` succeeded; `getWebhookInfo` showed the tunnel URL with `allowed_updates: ['message']`.
- One private message was stored once.
- One agent run `replied`; the reply was `sent` with Telegram's message id.
- A POST without the secret through the tunnel got 401.

Not run: `pnpm test:browser`, `pnpm build`, Prettier on touched files (the existing files were already not Prettier-clean).

## Known issues and uncertainties

- Telegram, not verified live: disconnect/`deleteWebhook`, real 403/401 shapes, media messages.
- There is no `update_id` table; dedupe relies on the message id.
- 9× `instagram poll failed` with Meta code 200 during this run, cause not investigated. The Meta app callback and webhook URLs still point at an old tunnel.
- Meta sends no real Instagram webhook POSTs. Root cause unknown.
- Not verified: Instagram poll ids equal webhook `mid`s; the 24-hour window; revocation.
- No durable dispatch queue.
- An uncertain-send echo may create a duplicate `human` row.
- The quick-tunnel URL changes on every restart.
- `~/.config/hepson/api.log` may contain secrets.

## Next actions

1. Review and commit P2 (suggested: `feat(api): Telegram customer channel (P2)`).
2. Live: disconnect the bot from the dashboard; `getWebhookInfo` should show an empty URL.
3. Look into the Instagram poll error code 200 (`services/instagram.ts` `pollOnce`, `instagram-graph.ts` `recentMessages`), then reconnect Instagram on the current tunnel.
4. Run `pnpm test:browser` and `pnpm build`.
5. Start P3 (policies and the `get_policy` tool) per `docs/ROADMAP.md`.
