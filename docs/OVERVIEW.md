# Hepson: codebase overview and next steps

> **2026-10-29 pivot (D22-D28):** the product now competes with NovaSale on official APIs; the Phase 1 browser connector is frozen. This guide describes the code as built (F1-F12). Its "Plans for next features" section and the line "the AI never takes payments" are superseded by `docs/ROADMAP.md` (P-series), D24 (the AI never handles money; it relays a server-generated link) and D26 (autonomy levels).

Written 2026-10-29. This is a reader's guide, not a state record. Current implementation state lives in `docs/AI_HANDOFF.md`, feature status in `docs/ROADMAP.md`, and design reasoning in `docs/DECISIONS.md` (D1-D21).

## What Hepson is

A Ukrainian-first, multi-shop SaaS AI sales assistant for online shops. It answers customer questions from verified catalog data, discusses variants and stock, and prepares **order drafts** that a human approves. Shop members watch chats, pause the AI, take over, and review drafts. The AI never takes payments, confirms orders, or decides refunds. Unknown or sensitive requests escalate to a human.

It has two layers:

1. **Phase 1, the Instagram Direct connector.** A local, authenticated HTTP API (REST + SSE) that reads and sends DMs for shop-owned, owner-authorized Instagram accounts through a persistent headed Chromium profile. Live-verified on one account only.
2. **Phase 2, the SaaS layer.** Shops, users, catalog, conversations, the AI agent, orders, notifications, stats, website chat and an owner dashboard. All Phase 2 data is shop-scoped.

## Stack

Node 22+ (dev on 24), TypeScript strict, pnpm workspace, Fastify 5, Zod 4, SQLite through better-sqlite3 and Drizzle, Playwright, Vitest, React + Vite for both front ends. The LLM is OpenAI, called through plain `fetch` behind a provider-neutral interface.

## Repository map

| Path | Role |
|---|---|
| `packages/connector-core` | Shared types, errors, events, message fingerprinting |
| `packages/database` | Drizzle schema, migrations `0001`-`0008`, `Store` (Phase 1) and one repository per Phase 2 area (`shops`, `auth`, `catalog`, `catalog-import`, `conversations`, `agent`, `orders`, `stats`, `webchat`) |
| `packages/mock-adapter` | In-memory connector for tests and demos |
| `packages/instagram-browser` | All Instagram DOM knowledge (`selectors.ts`, `parsers.ts`), profile, lock, login and sender |
| `apps/api` | Fastify server: `routes/`, `services/`, `auth/`, `agent/`, `widget/` |
| `apps/dev-console` | Admin-key tool for Phase 1 connector accounts |
| `apps/dashboard` | Shop-owner UI (user sessions, port 5174) |
| `scripts/` | `migrate`, `bootstrap-key`, `backup`, `gen-openapi`, `calibrate-selectors`, `live-smoke` |
| `tests/` | `unit/`, `integration/` (mock, `app.inject`), `e2e/` (real Chromium against a local fake Instagram) |

## How the pieces fit

```
Instagram DM ──► connector (browser adapter) ──► message.received ─┐
                                                                    ├─► SalesAgent ──► OpenAI tool loop
Website visitor ─► /public/web-chat ─► WebChatService ─────────────┘        │
                                                                            ▼
                                                    reply guard (no unverified price/stock)
                                                                            ▼
                              deliverPending ──► connector send queue  |  internal (website)
                                                                            ▼
                                                   ChannelBridge adopts the pending shop row
```

- **Channel bridge.** Mirrors Phase 1 account-scoped conversations into shop-scoped `customers`, `shop_conversations` and `shop_messages`. Phase 1 tables are never altered.
- **Sales agent.** One run per inbound message, serial per conversation. Tools: `search_products`, `get_variant`, `quote_order`, `create_order_draft`, `escalate`. The server computes prices and totals. The reply guard blocks any price or stock figure that no tool returned (one repair attempt, then escalate and send nothing).
- **Human takeover.** Per-conversation AI pause. A human reply pauses the AI first. Telegram notifies on new escalations and order drafts.
- **Orders.** Drafts are always `pending_approval`. Approval reduces stock atomically, all or nothing.
- **Auth.** `hsu_` user sessions with owner and manager roles. Phase 1 uses `hep_` API keys. The two never mix: user routes reject API keys.
- **Website chat.** Public routes protected by a widget key, an exact Origin allow-list, per-visitor tokens and rate limits (D19).
- **Catalog.** Products and variants, integer minor-unit prices, SKU unique per shop, stock never below zero, Cyrillic-safe search, CSV import with dry run (D21).

## Invariants worth keeping in your head

- Every query is scoped by shop (Phase 2) or account (Phase 1). An id from another tenant is "not found".
- One persistent browser profile per Instagram account; never deleted except by explicit forget.
- Hepson never handles Instagram credentials or cookies.
- Adapters throw only before an irreversible UI action. After that they return `uncertain`, which is never auto-retried.
- Model output is never authoritative for price or stock.
- Secrets come from the environment only. Nothing auto-loads `.env`.

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
```

`pnpm format` is not clean repo-wide; do not run it blindly.

## Where things stand

Phase 1 and Phase 2 features 1-12 are built. Last validation (2026-10-29): typecheck clean, 254 unit and integration tests, 23 real-browser tests. Nothing is committed yet (about 80 changed paths on `main`).

Not verified live, because it needs an authorized account or tokens: the agent and human reply on real Instagram, live Telegram, live OpenAI since the F8-F11 changes, and website chat behind a real proxy and domain.

## Plans for next features

Ordered by what I would do first. Items marked **needs you** depend on an account, a token or a decision only the owner can make.

### 0. Housekeeping before more features
1. **Commit F1-F12** in several logical commits (migrations and repositories, API routes, agent, dashboard, docs). **Needs you.**
2. **Live checks, one at a time:** run `pnpm migrate`, export the env vars, link the authorized Instagram account to a shop (`PUT /v1/accounts/:id/shop`), enable AI, send a test DM and confirm exactly one reply. Then a Telegram bot token plus chat id, then the widget on a real allowed origin. **Needs you.**
3. **Dashboard automated UI tests** (Playwright against the built dashboard). The only dashboard coverage today is one manual smoke run.

### 1. Make the AI useful beyond product Q&A
- **Policies and FAQ tool.** Per-shop delivery, returns, payment and opening-hours text that the agent can look up, with the same "no fact without a tool" rule as prices. This is the biggest gap in answer quality.
- **Per-shop language and tone**, and a per-shop model choice.
- **Cost and usage limits per shop.** Tokens are already recorded; add a monthly cap and a clear stop behavior. Required before taking paying customers.
- **Image understanding** for customers who send a photo of a product. Needs a decision on cost and on how images are stored.

### 2. Close the order loop
- **Tell the customer about a decision.** After approve or reject, send the customer a message through the same channel (idempotent, human-reviewed wording).
- **Manual draft creation and editing** by members, and order numbers.
- **Stock reservation before approval**, so two pending drafts cannot promise the same last item.
- **Idempotency key on human replies**, so a retry after a timeout cannot send twice.

### 3. Catalog completeness
- **Product and variant delete** (today only deactivate), media hosting, variant and description editing in the dashboard.
- **Excel import** and **feed sync** if shops ask for them. Both were deferred on purpose (D21): feed fetching needs an egress allow-list first.
- **Export**, so owners can round-trip a file instead of guessing the format.

### 4. Production readiness
- **Cookie sessions with CSRF protection** instead of a bearer token in `localStorage`; **email verification, password reset, 2FA**; a persistent login throttle.
- **Shared rate limits** (database or Redis) once there is more than one API node. Website chat limits are in memory per node today.
- **Website chat:** SSE instead of polling, CAPTCHA or proof-of-work if abuse appears.
- **Operations:** backup rotation and a tested restore script, metrics, structured alerting, deployment guide (reverse proxy, `HEPSON_TRUST_PROXY`, data directory permissions).
- **Telegram:** a test-message route and chat-id verification by handshake (D17 trade-off).

### 5. Dashboard growth
- Instagram onboarding (account linking is an admin-only task today), team and role management, AI settings editor, escalation inbox with filters, digest of paused conversations.

### 6. Channels and platform risk
- **`instagram-official` adapter** (Meta Graph API) as the supported long-term path (`docs/FUTURE_META_ADAPTER.md`). The browser adapter automates the web UI and may breach Instagram's terms (`docs/LIMITATIONS.md`), so this is the main business risk.
- Phase 1 backlog: live-test media, groups, a non-English UI, a second account, `uncertain` sends, concurrent sends and reboot recovery. On `UI_CHANGED`, run `pnpm calibrate <uuid>` and fix only `selectors.ts` and `parsers.ts`, keeping `tests/fixtures/fake-instagram.ts` in sync.
- Other channels (Telegram customer chat, Viber) follow the `ChannelBridge` pattern.

## Known weak spots

- Agent and bridge have never run against real Instagram.
- Wiping an account's data and resyncing duplicates messages in the shop.
- Mirrored `occurred_at` is observation time, and stats count by ingest time (D18).
- A human reply sent from the Instagram app itself does not auto-pause the AI (D16).
- Website chat `Origin` checks are not authentication (D19).
- CSV import sets stock from the file and can overwrite changes made since the export (D21).

## Working rules for contributors

One narrowly scoped feature per session. Read `docs/PROJECT_CONTEXT.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md` and `docs/AI_HANDOFF.md` first. End with tests, typecheck and doc updates. Never claim real-Instagram behavior is verified without a test on an authorized account. Never commit secrets, and never commit or push without the owner's say-so.
