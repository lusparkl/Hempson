# Hepson: codebase overview

Reader's guide to the code as built (F1-F12, P1-P5). Not a state record: current state lives in `docs/AI_HANDOFF.md`, feature status and plans in `docs/ROADMAP.md`, design reasoning in `docs/DECISIONS.md` (D1-D32). Updated 2026-11-01.

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
| `apps/api` | Fastify server: `routes/`, `services/` (`instagram*.ts`, `telegram*.ts`, `nova-poshta.ts` + `delivery.ts` (P4), `monobank.ts` + `payments.ts` (P5), `egress.ts`, `shop-sender.ts`, `web-chat.ts`, `notifier.ts`, Phase 1 `connector-service.ts`/`channel-bridge.ts`), `auth/`, `agent/`, `widget/` |
| `apps/dev-console` | Admin-key tool for Phase 1 connector accounts |
| `apps/dashboard` | Shop-owner UI (user sessions, port 5174) |
| `scripts/` | `migrate`, `bootstrap-key`, `backup`, `gen-openapi`, `gen-master-key`, `rewrap-credentials`; browser-only `calibrate-selectors`, `live-smoke` |
| `tests/` | `unit/`, `integration/` (mock, `app.inject`), `e2e/` (real Chromium against a local fake Instagram) |

## How the pieces fit

```
Instagram DM ─► /webhooks/instagram or polling ─► InstagramService ─┐
Telegram msg ─► /webhooks/telegram/:id ─► TelegramService ──────────┤
Website visitor ─► /public/web-chat ─► WebChatService ──────────────┼─► SalesAgent ─► OpenAI tool loop
(frozen) browser adapter ─► ConnectorService ─► ChannelBridge ──────┘        │
                                                                             ▼
      reply guard (no unverified price/stock/policy claim/parcel status)
                                                                             ▼
                          shop-sender: Instagram Send API | Telegram sendMessage | website (internal) | browser send queue
```

- **Official Instagram.** `InstagramService` writes straight into the shop tables on channel `instagram-official` (D23 amendment). Signed webhooks and the polling fallback share one ingest path with dedupe on Meta's message id; echoes adopt our pending row. Sends check the 24-hour window first; `uncertain` is never retried. Tokens live in `CredentialVault`; all outbound HTTP goes through `createEgress`.
- **Telegram.** One bot per shop (D27). The owner pastes the BotFather token; `TelegramService` checks it with `getMe`, registers the webhook (opaque path, random secret header, stored hashed) and keeps the token in `CredentialVault`. Ingest writes to channel `telegram` with message id `<chat_id>:<message_id>`; private chats only. A blocked bot makes the send `failed`; a rejected token marks the channel `needs_reconnect` and notifies the owner.
- **Channel bridge (frozen path). Mirrors Phase 1 account-scoped conversations into shop-scoped `customers`, `shop_conversations` and `shop_messages`. Phase 1 tables are never altered.
- **Sales agent.** One run per inbound message, serial per conversation. Tools: `search_products`, `get_variant`, `quote_order`, `get_policy` (P3), `find_np_city`, `find_np_branch`, `get_checkout_options`, `create_order_draft`, `get_order_status` (P4), `escalate`. The server computes prices and totals. The reply guard blocks any price or stock figure that no tool returned, any period/hours/returns/payment/free-delivery claim not backed by `get_policy` in the same run, any parcel status or TTN not from `get_order_status`, and any "paid" claim or payment link not from `get_order_status` (one repair attempt, then escalate and send nothing).
- **Policies (P3).** `PolicyRepository` (`shop_policies`): one text per topic, versioned; owner edits. No text = the agent escalates.
- **Checkout and Nova Poshta (P4).** The shop's NP key is in `CredentialVault` (kind `nova_poshta`). `DeliveryService` does lookups, TTN creation (DB claim first, at most one per order, `uncertain` never retried) and tracking (`HEPSON_NOVA_POSHTA_POLL_MINUTES`). `DeliveryRepository` holds sender settings and the per-customer refusal count (D25).
- **Payment links (P5, D24, D32).** The shop's Monobank acquiring token is in `CredentialVault` (kind `monobank`). Approval into `awaiting_payment` sets the payment deadline; `PaymentService` creates one invoice for the stored total (`PaymentRepository` claim first, one active attempt per order), sends the fixed-template link as a `system` message (`sendSystemMessage`), verifies webhooks (`/webhooks/monobank/:webhookId`, `x-sign`), applies statuses idempotently and in order (`payment_events`), and every `HEPSON_PAYMENT_CHECK_MINUTES` reconciles open invoices, sends the one reminder and cancels expired orders with restock. `paid` starts the prepaid TTN (`DeliveryService.afterPaid`). Prepaid is offered only while a Monobank credential is active.
- **Human takeover.** Per-conversation AI pause. A human reply pauses the AI first. Telegram notifies on new escalations and order drafts.
- **Orders.** D25 lifecycle in `OrderRepository`, every transition in `order_events`. Approval needs complete checkout data, reduces stock atomically (all or nothing) and moves to `cod_confirmed` (TTN created, then `shipped`) or `awaiting_payment` (waits for P5). Tracking moves `shipped` to `delivered` or `returning`; a member confirms `returned` (restock once). `auto_confirm` (D26) lets the server approve when every check passes.
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
