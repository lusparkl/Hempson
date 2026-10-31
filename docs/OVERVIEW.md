# Hepson: codebase overview

Reader's guide to the code as built (F1-F12, P1). Not a state record: current state lives in `docs/AI_HANDOFF.md`, feature status and plans in `docs/ROADMAP.md`, design reasoning in `docs/DECISIONS.md` (D1-D30). Updated 2026-10-31.

## What Hepson is

A Ukrainian-first, multi-shop SaaS AI sales assistant for online shops. It answers customer questions from verified catalog data, discusses variants and stock, and prepares **order drafts** that a human approves. Shop members watch chats, pause the AI, take over, and review drafts. The AI never handles money (D24), never confirms orders on its own (D26) and never decides refunds. Unknown or sensitive requests escalate to a human.

It has three layers:

1. **Phase 1, the Instagram Direct connector (frozen, D22).** Account-scoped `/v1/accounts` API (REST + SSE) over a persistent headed Chromium profile, plus a mock adapter. Off by default (`HEPSON_ENABLE_BROWSER_ADAPTER`); kept with its tests until `instagram-official` is live-verified.
2. **Phase 2, the SaaS layer (F1-F12).** Shops, users, catalog, conversations, the AI agent, orders, notifications, stats, website chat and an owner dashboard. All data is shop-scoped.
3. **Pivot layer (P1 built).** Official Instagram (Unified login, D29), the encrypted per-shop credential store (D28) and the egress allow-list (D22). P2-P9 are planned.

## Stack

Node 22+ (dev on 24), TypeScript strict, pnpm workspace, Fastify 5, Zod 4, SQLite through better-sqlite3 and Drizzle, Playwright, Vitest, React + Vite for both front ends. The LLM is OpenAI, called through plain `fetch` behind a provider-neutral interface.

## Repository map

| Path | Role |
|---|---|
| `packages/connector-core` | Shared types, errors, events, message fingerprinting |
| `packages/database` | Drizzle schema, migrations `0000`-`0010`, `Store` (Phase 1) and one repository per area (`shops`, `auth`, `catalog`, `catalog-import`, `conversations`, `agent`, `orders`, `stats`, `webchat`, `instagram`), `CredentialVault`/`Keyring` (`credentials.ts`) |
| `packages/mock-adapter` | In-memory connector for tests and demos |
| `packages/instagram-browser` | Frozen browser adapter: all Instagram DOM knowledge (`selectors.ts`, `parsers.ts`), profile, lock, login and sender |
| `apps/api` | Fastify server: `routes/`, `services/` (`instagram*.ts`, `egress.ts`, `shop-sender.ts`, `web-chat.ts`, `notifier.ts`, Phase 1 `connector-service.ts`/`channel-bridge.ts`), `auth/`, `agent/`, `widget/` |
| `apps/dev-console` | Admin-key tool for Phase 1 connector accounts |
| `apps/dashboard` | Shop-owner UI (user sessions, port 5174) |
| `scripts/` | `migrate`, `bootstrap-key`, `backup`, `gen-openapi`, `gen-master-key`, `rewrap-credentials`; browser-only `calibrate-selectors`, `live-smoke` |
| `tests/` | `unit/`, `integration/` (mock, `app.inject`), `e2e/` (real Chromium against a local fake Instagram) |

## How the pieces fit

```
Instagram DM ─► /webhooks/instagram or polling ─► InstagramService ─┐
Website visitor ─► /public/web-chat ─► WebChatService ──────────────┼─► SalesAgent ─► OpenAI tool loop
(frozen) browser adapter ─► ConnectorService ─► ChannelBridge ──────┘        │
                                                                             ▼
                                                     reply guard (no unverified price/stock)
                                                                             ▼
                          shop-sender: Instagram Send API | website (internal) | browser send queue
```

- **Official Instagram.** `InstagramService` writes straight into the shop tables on channel `instagram-official` (D23 amendment). Signed webhooks and the polling fallback share one ingest path with dedupe on Meta's message id; echoes adopt our pending row. Sends check the 24-hour window first; `uncertain` is never retried. Tokens live in `CredentialVault`; all outbound HTTP goes through `createEgress`.
- **Channel bridge (frozen path).** Mirrors Phase 1 account-scoped conversations into shop-scoped `customers`, `shop_conversations` and `shop_messages`. Phase 1 tables are never altered.
- **Sales agent.** One run per inbound message, serial per conversation. Tools: `search_products`, `get_variant`, `quote_order`, `create_order_draft`, `escalate`. The server computes prices and totals. The reply guard blocks any price or stock figure that no tool returned (one repair attempt, then escalate and send nothing).
- **Human takeover.** Per-conversation AI pause. A human reply pauses the AI first. Telegram notifies on new escalations and order drafts.
- **Orders.** Drafts are always `pending_approval`. Approval reduces stock atomically, all or nothing.
- **Auth.** `hsu_` user sessions with owner and manager roles. Phase 1 uses `hep_` API keys. The two never mix: user routes reject API keys.
- **Website chat.** Public routes protected by a widget key, an exact Origin allow-list, per-visitor tokens and rate limits (D19).
- **Catalog.** Products and variants, integer minor-unit prices, SKU unique per shop, stock never below zero, Cyrillic-safe search, CSV import with dry run (D21).

## Invariants worth keeping in your head

- Every query is scoped by shop (Phase 2) or account (Phase 1). An id from another tenant is "not found".
- One persistent browser profile per Instagram account; never deleted except by explicit forget (frozen adapter).
- Hepson never handles Instagram passwords or cookies. Per-shop provider tokens live only in the encrypted store and are never logged or returned (D28).
- Payment state comes only from verified provider events (D24).
- Adapters throw only before an irreversible UI action. After that they return `uncertain`, which is never auto-retried.
- Model output is never authoritative for price or stock.
- Operator secrets come from the environment only. Nothing auto-loads `.env`.

## Everyday commands

```
pnpm install && pnpm rebuild better-sqlite3     # if the native binding is missing
pnpm exec playwright install chromium
pnpm migrate                                     # also: pnpm exec drizzle-kit generate
pnpm bootstrap-key                               # once
pnpm start:api | pnpm dev:dashboard | pnpm dev:console
pnpm test | pnpm test:browser | pnpm typecheck
pnpm openapi                                     # regenerate docs/openapi.json
pnpm backup [dest]                               # online SQLite backup
pnpm gen-master-key | pnpm rewrap-credentials    # credential master key (D28)
```

`pnpm format` is not clean repo-wide; do not run it blindly.

## Known weak spots

- Meta delivers no real message webhooks; development runs on polling (D30, `docs/LIMITATIONS.md`).
- No durable queue between ingest and agent dispatch.
- An `uncertain` Instagram send whose echo arrives later may leave a duplicate `human` row.
- Wiping an account's data and resyncing duplicates messages in the shop.
- Mirrored `occurred_at` is observation time, and stats count by ingest time (D18).
- A human reply sent from the Instagram app itself is stored but does not auto-pause the AI (D16).
- Website chat `Origin` checks are not authentication (D19).
- CSV import sets stock from the file and can overwrite changes made since the export (D21).

## Working rules for contributors

One narrowly scoped feature per session. Read `docs/PROJECT_CONTEXT.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md` and `docs/AI_HANDOFF.md` first. End with tests, typecheck and doc updates. Never claim real-Instagram behavior is verified without a test on an authorized account. Never commit secrets, and never commit or push without the owner's say-so.
