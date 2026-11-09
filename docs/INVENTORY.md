# Hepson: inventory of what exists

Snapshot of the repository at commit `87349cd` (branch `feat/redesign`, 2026-11-04), updated on 2026-11-06 for the Phase 1 removal (D41). It lists what is built, where it lives, what each screen and page does, and what is verified versus only tested against fakes. Built from the source tree, not only from the other docs. For reasoning see `docs/DECISIONS.md` (D1–D40), for plans `docs/ROADMAP.md`, for the current working state `docs/AI_HANDOFF.md`.

Legend used below:
- **Built** = code and automated tests exist.
- **Live-checked** = run once against the real platform with an authorized account.
- **Fake-only** = tested only against a local fake written from the provider's public documentation.

---

## 1. What the product is

Hepson is a Ukrainian-first, multi-shop SaaS AI sales assistant for small online shops. A customer writes in Instagram Direct, the shop's Telegram bot or a chat widget on the shop's website. The AI agent answers from verified catalog data and shop-written policy texts, recommends products, collects checkout data (name, phone, Nova Poshta city and branch, payment method) and creates an **order draft**. A person approves the draft (or the server auto-confirms it under a sum limit). After approval the system can create a Nova Poshta waybill (TTN), send a Monobank payment link, track the parcel and notify the customer at each step.

Hard rules that shape everything:
- Official APIs only (D22). The original browser-automation Instagram connector was removed (D41).
- The AI never handles money, never invents prices, stock, policies, parcel status or payment status (reply guard), never confirms orders on its own unless the shop enabled `auto_confirm` (D26).
- Every shop's provider credentials are encrypted in `CredentialVault` and never read back (D28).
- Payment state changes only from verified provider events (D24).
- All outbound HTTP goes through an allow-list (`services/egress.ts`).
- Every query is scoped to a shop.

Competitive target: NovaSale (Ukrainian AI sales assistant), on trust and price.

---

## 2. Status at a glance

| Area | Status | Verified how |
|---|---|---|
| F0 Phase 1 browser Instagram connector | **Removed** 2026-11-06 (D41) | Was live-verified on one account (2026-10-28) |
| F1–F12 SaaS core (shops, auth, catalog, conversations, agent, orders, takeover, stats, website chat, dashboard, CSV import) | Built | Tests; one live OpenAI smoke run |
| P1 Official Instagram (Unified login) | Built | Live: connect, polling intake, AI reply, echo on one tester account. **Webhook delivery from Meta not working** (D30) |
| P2 Telegram customer channel (bot per shop) | Built | Live: connect, one message, one AI reply. Disconnect not live-checked |
| P3 Shop policies + `get_policy` tool | Built | Tests only (no external platform) |
| P4 Checkout + Nova Poshta (lookups, TTN, tracking, refusals) | Built | Fake-only |
| P5 Monobank payment links | Built | Fake-only. WayForPay **not built** |
| P6 Customer notifications | Built | Fakes |
| P7 Plans and AI-reply quotas | Built | Tests |
| P8 Google Sheets and XLSX import, Excel export, funnel stats | Built | Sheets fake-only. XLSX tested on generated files only (D43) |
| P9 Suggestions, photo search, forwarded posts, storefront | Built | Tests with fakes. Instagram media CDN host unknown until a live capture (D42) |
| P10 Dashboard v3 parity (unread, notes, notification centre, order numbers, dense stats) | Built | Tests + manual Playwright pass |
| W1 Public marketing website (12 pages, Ukrainian) | Built | Builds; content placeholders remain (contacts, prices, legal entity) |
| Design system `packages/ui` (D38) | Built | Used by dashboard and website |
| Hepson subscription billing, Meta App Review, Business Verification | **Blocked** on business registration (FOP) | — |

Last validation (2026-11-04): `pnpm typecheck` 0 errors; `pnpm test` 490 tests passed in 40 files; `pnpm build` and `pnpm build:website` OK. Not run in that pass: `pnpm test:browser`, any real Telegram / Nova Poshta / Monobank / Instagram call.

---

## 3. Repository layout

pnpm workspace (`apps/*`, `packages/*`), Node ≥22 (dev on 24), TypeScript strict, ESM. Roughly 31,700 lines of tracked source and tests (excluding fonts, logos, migration snapshots, `docs/openapi.json`).

```
apps/
  api/            Fastify 5 server: routes, services, AI agent, website-chat widget
  dashboard/      React + Vite shop-owner cabinet (port 5174)
  website/        Prerendered public marketing site, Ukrainian only (port 5175)
packages/
  database/           Drizzle schema, SQL migrations 0000–0017, repositories, CredentialVault
  ui/                 Shared design system: tokens, components, icons, fonts, animated embeds
scripts/          migrate, bootstrap-key, backup, gen-openapi, gen-master-key, rewrap-credentials
tests/            unit/ (16 files), integration/ (19 files), e2e/ (1 file), fixtures/ (fake Monobank, fake Nova Poshta, scripted LLM)
docs/             AI_HANDOFF, API, DECISIONS, LIMITATIONS, OVERVIEW, PROJECT_CONTEXT, ROADMAP, openapi.json, INVENTORY (this file)
```

Root tooling: `drizzle.config.ts`, `vitest.config.ts`, `vitest.browser.config.ts`, `tsconfig.json`, `.prettierrc.json`, `.env.example` (every setting documented, nothing auto-loaded).

### Main dependencies
Runtime: `fastify` 5 (with its own `pino` logger), `zod` 4, `better-sqlite3` + `drizzle-orm`. Front ends: `react` 19, `vite` 8, `@vitejs/plugin-react`. Dev: `typescript`, `vitest`, `tsx`, `drizzle-kit`, `prettier`, `playwright` (widget browser test only). No auth library, no HTTP client library, no XLSX library (own writer and reader), no OpenAI SDK (plain `fetch`).

---

## 4. Backend: `apps/api`

Entry: `src/index.ts` → `src/server.ts` (builds the app, wires services, timers, security headers, OpenAPI at `GET /v1/openapi.json`). Config from environment only: `src/config.ts`.

### 4.1 Authentication
- **Dashboard users:** email + password (scrypt, `auth/password.ts`), opaque bearer session token `hsu_…` (only its hash is stored), login throttle (`auth/throttle.ts`). Roles per shop: `owner` and `manager`. Last owner cannot be removed. Session TTL `HEPSON_SESSION_TTL_DAYS` (30). Self-registration toggle `HEPSON_ALLOW_REGISTRATION`.
- **Operator API keys:** `hep_…` (`pnpm bootstrap-key`), accepted only by `PUT .../plan` (fallback; D41). Shop routes reject API keys; that route rejects user sessions.
- Cross-shop access returns `404`; a manager doing an owner-only write gets `403`.

### 4.2 HTTP routes (all built)

Shop API (user session, `/v1/shops/:shopId/...` checks membership):

| Area | Routes |
|---|---|
| Meta | `GET /health`, `GET /ready` (DB check), `GET /v1/openapi.json` |
| Auth | `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/logout`, `GET /v1/auth/me` |
| Shops & team | `POST/GET /v1/shops`, `GET/PATCH /v1/shops/:shopId`, `GET/POST .../members`, `PATCH/DELETE .../members/:userId` |
| Catalog | `POST/GET .../products`, `GET/PATCH .../products/:productId`, `POST .../products/:productId/variants`, `PATCH .../variants/:variantId`, `POST .../variants/:variantId/stock` (atomic delta), `POST .../products/import` (CSV, dry run default), `POST .../products/import-xlsx` (first worksheet, base64), `POST .../products/import-sheet` (Google Sheets link), `GET .../photo-index`, `POST .../photo-index/retry` |
| Customers & chats | `GET .../customers`, `GET .../customers/:customerId` (profile card), `PUT .../customers/:customerId/note`, `GET .../conversations`, `GET .../conversations/unread-count`, `GET .../conversations/:id`, `PUT .../conversations/:id/read`, `GET/POST .../conversations/:id/messages` (human reply), `PUT .../conversations/:id/ai` (pause/resume AI) |
| AI agent | `GET/PUT .../ai` (enabled, instructions, autonomy, auto-confirm max sum), `GET .../ai/runs`, `GET .../escalations`, `POST .../escalations/:id/resolve` |
| Orders | `GET .../order-drafts` (filters incl. `customerId`), `GET .../order-drafts/export.xlsx?from&to&status`, `GET .../order-drafts/:draftId`, `POST .../:draftId/approve`, `POST .../:draftId/reject`, `POST .../:draftId/{cancel,returned,ttn,ttn/release,payment-link,refund-requested}`, `GET .../:draftId/events`, `GET .../:draftId/payments` |
| Policies | `GET .../policies`, `PUT .../policies/:topic` (`delivery`, `returns`, `payment`, `hours`; owner) |
| Nova Poshta | `GET .../nova-poshta`, `PUT/DELETE .../nova-poshta/key`, `PUT .../nova-poshta/settings`, `GET .../nova-poshta/cities?q`, `GET .../nova-poshta/branches?cityRef&q`, `GET/POST .../customers/:customerId/refusals`, `DELETE .../refusals/:refusalId` |
| Monobank | `GET .../monobank`, `PUT/DELETE .../monobank/token`, `PUT .../monobank/settings` (payment timeout, reminder hours) |
| Instagram (official) | `GET/DELETE .../instagram`, `POST .../instagram/connect` |
| Telegram (shop bot) | `GET/PUT/DELETE .../telegram` |
| Website chat config | `GET/PUT .../web-chat`, `POST .../web-chat/rotate-key` |
| Team notifications (Telegram chat) | `GET/PUT .../notifications` |
| Notification centre | `GET .../notification-feed`, `POST .../notification-feed/seen` |
| Stats & plans | `GET .../stats?from&to` (incl. usage, funnel, order sources, dense daily series), `GET .../usage`, `PUT .../plan` (admin key) |

Public and webhook routes:

| Route | Purpose |
|---|---|
| `GET /s/:slug` | Public storefront page (P9, off until the owner enables it; active in-stock products, website chat widget, Telegram/Instagram links) |
| `GET /widget/web-chat.js` | Embeddable chat widget script |
| `POST /public/web-chat/:widgetKey/session`, `POST/GET /public/web-chat/:widgetKey/messages` | Website visitor chat (widget key, Origin allow-list, visitor token, rate limits) |
| `GET /public/instagram/callback` | OAuth return from Meta Unified login |
| `GET/POST /webhooks/instagram` | Meta handshake and signed events (`X-Hub-Signature-256` over raw body) |
| `POST /webhooks/telegram/:webhookId` | Shop bot updates (opaque path + secret header) |
| `POST /webhooks/monobank/:webhookId` | Payment status (`x-sign` ECDSA over raw body) |

The Phase 1 connector API (`/v1/accounts/...`) was removed (D41).

Error envelope everywhere: `{ "error": { "code", "message", "retryable" } }`.

### 4.3 Services (`src/services/`)

| File | What it does |
|---|---|
| `egress.ts` | `createEgress`: the only way to make outbound HTTP; allow-list = OpenAI, Instagram/Meta Graph, Telegram, Nova Poshta, Monobank, WayForPay, Google Sheets hosts, plus `HEPSON_EGRESS_EXTRA_HOSTS` |
| `instagram-graph.ts` | Meta Graph HTTP client (token exchange, subscription, conversations, send, profile) |
| `instagram.ts` | `InstagramService`: OAuth connect (single-use `state`), webhook ingest with dedupe on Meta message id, polling fallback (`HEPSON_INSTAGRAM_POLL_SECONDS`), echo adoption, 24-hour window check before send, token expiry → `needs_reconnect` |
| `telegram-bot.ts` | Bot API client: `getMe`, `setWebhook`, `deleteWebhook`, `sendMessage` |
| `telegram.ts` | `TelegramService`: connect by token paste, webhook registration with random secret (stored hashed), ingest of private chats only, send; 401/404 → `needs_reconnect`, 403 → `BOT_BLOCKED` |
| `web-chat.ts` | `WebChatService`: visitor sessions, messages, limits |
| `shop-sender.ts` | One send path for all channels (Instagram Send API, Telegram, website internal); `sendSystemMessage` for fixed templates |
| `notifier.ts` | `TelegramNotifier`: tells the shop's team chat about new escalations, new order drafts, payment/TTN problems, quota reached (operator-wide bot `HEPSON_TELEGRAM_BOT_TOKEN`) |
| `alerts.ts` | `AlertMonitor`: operator alerts in Telegram from probes, real traffic and events (D49); `observeEgress`, `alertSender`, `withChannelIssueAlerts` |
| `health-probes.ts` | `buildProbes`: one check per dependency; `trafficReporter` maps provider hosts to incidents |
| `nova-poshta.ts` | NP API client: cities, warehouses, sender counterparty/contact, `Counterparty.save`, `InternetDocument.save`, `getStatusDocuments` |
| `delivery.ts` | `DeliveryService`: lookups, TTN creation (DB claim first, at most one per order, `uncertain` never retried), tracking timer (`HEPSON_NOVA_POSHTA_POLL_MINUTES`), `afterPaid` for prepaid orders |
| `monobank.ts` | Monobank acquiring client: create/remove invoice, status, public key, signature verify |
| `payments.ts` | `PaymentService`: one invoice per order for the stored total, link message, webhook apply (idempotent, ordered), reconciliation every `HEPSON_PAYMENT_CHECK_MINUTES`, one reminder, cancel expired with restock, amount mismatch → escalate |
| `customer-notices.ts` | `CustomerNoticeService`: sends queued fixed-text notices once (`confirmed`, `rejected`, `paid`, `shipped`, `delivered`); crash mid-send → `uncertain` |
| `google-sheets.ts` | Fetches a link-shared sheet as CSV (only Google hosts, one redirect to googleusercontent) |
| `xlsx.ts` | Dependency-free one-sheet XLSX writer (order export) and first-sheet reader (catalog import) |
| `photo-search.ts` | P9 photo index (background indexing of product main images) and customer-photo matching; customer bytes in memory only |
| `rate-limit.ts` | In-memory limiter for website chat |
| `event-bus.ts` | In-process pub/sub (`message.received` etc.) |

### 4.4 AI sales agent (`src/agent/`)
- `llm.ts`: provider-neutral interface; `OpenAiClient` over `fetch` (chat completions with tools). Active only when `OPENAI_API_KEY` and `HEPSON_OPENAI_MODEL` are both set (tested: `gpt-5.4-nano`, `gpt-4o-mini`, `gpt-4.1-mini`).
- `prompt.ts`: Ukrainian-first system prompt plus the shop's own instructions.
- `sales-agent.ts`: one run per inbound customer message (unique), serial per conversation, drops a reply if a newer customer message arrived, skips paused conversations, checks the monthly quota before any model call, records every run in `ai_runs`.
- `tools.ts` — 11 tools, server computes all prices and totals:
  1. `search_products` — catalog search (Cyrillic-safe)
  2. `get_variant` — exact variant, price, stock
  3. `suggest_products` — alternatives (same product / shared name words) or complements (bought together in past drafts), max 3
  4. `quote_order` — server-side total
  5. `get_policy` — shop's text for delivery/returns/payment/hours, or "not available → escalate"
  6. `find_np_city`, 7. `find_np_branch` — Nova Poshta lookups
  8. `get_checkout_options` — allowed payment methods (COD hidden at refusal limit; prepaid only with active Monobank)
  9. `create_order_draft` — needs names, phone, NP refs from this run, payment method; may auto-confirm
  10. `get_order_status` — status, TTN, parcel and payment state
  11. `escalate` — hand off to a person
- `guard.ts` (reply guard): blocks any price/stock figure no tool returned; any period, clock time, returns/payment/free-delivery/hours claim not backed by `get_policy` in the same run; any parcel status or TTN not from `get_order_status`; any "paid" claim or payment link not from `get_order_status`. One repair attempt, then escalate and send nothing.

### 4.5 Background timers
- Instagram polling (optional), Nova Poshta tracking (60 min), payment reconciliation/reminders/expiry (5 min), customer notice sender, expired website-chat session purge, dead user-session purge (6-hourly), Instagram token expiry check.

### 4.6 Website chat widget (`src/widget/web-chat.js`)
Plain script served at `/widget/web-chat.js`. Shadow DOM, `textContent` only (no HTML injection), visitor token in `localStorage` (`hepson-chat-<key>`), polls every 3 s. No typing indicator, uploads or styling options.

---

## 5. Data model: `packages/database`

SQLite through better-sqlite3 + Drizzle (`schema.ts`, ~900 lines). Migrations `0000_init` … `0016_p10_parity` (17 files; `0005` and `0010` are column-only/empty SQL). Apply with `pnpm migrate`.

### 5.1 Tables (38)

| Group | Tables |
|---|---|
| Operator | `api_keys` (admin keys only; the Phase 1 tables were dropped by `0017_drop_phase1`, D41) |
| Shops & users | `shops`, `users`, `memberships`, `user_sessions` |
| Catalog | `products` (incl. `media` URL list), `product_variants` (SKU unique per shop, stock CHECK ≥ 0, integer minor-unit prices) |
| Conversations | `customers` (+ `note`, note author/time), `shop_conversations` (+ AI pause fields), `shop_messages` (direction, sender `customer/ai/human/system`, delivery status), `conversation_reads` (per-member unread marker) |
| AI | `shop_ai_settings` (enabled, instructions, autonomy, auto-confirm max), `ai_runs`, `escalations` |
| Orders | `order_drafts` (per-shop `number`, checkout fields, NP refs, payment method, TTN state/number/status, payment due/reminder), `order_draft_items`, `order_events` (audit of every transition), `customer_refusals` |
| Delivery & payments | `shop_delivery_settings`, `shop_payment_settings`, `order_payments`, `payment_events` |
| Policies | `shop_policies` (topic, text ≤4000, version, author) |
| Notifications | `shop_notify_settings` (team Telegram chat), `customer_notices`, `notification_reads` (notification-centre `seenAt` per member) |
| Channels | `instagram_channels` (+ `polled_until`), `instagram_oauth_states`, `telegram_channels`, `web_chat_configs`, `web_chat_sessions` |
| Credentials & plans | `shop_credentials` (envelope-encrypted), `shop_plans` |

### 5.2 Repositories (one per area)
`shops.ts`, `auth.ts`, `catalog.ts`, `catalog-import.ts`, `conversations.ts`, `agent.ts`, `orders.ts`, `stats.ts`, `webchat.ts`, `instagram.ts`, `telegram.ts`, `policies.ts`, `delivery.ts`, `payments.ts`, `notices.ts`, `notifications.ts`, `plans.ts`, `api-keys.ts` (operator keys), `credentials.ts` (`CredentialVault` + `Keyring`: AES envelope encryption, master-key versions, rotation via `pnpm rewrap-credentials`, no read-back API).

### 5.3 Enumerations (`order-kinds.ts`, `credential-kinds.ts`)
- Order statuses (D25): `pending_approval`, `approved`, `awaiting_payment`, `cod_confirmed`, `paid`, `shipped`, `delivered`, `returning`, `returned`, `rejected`, `cancelled`, `refund_requested`.
- Payment methods: `cod`, `prepaid`. Providers: `monobank` (WayForPay deferred, D44).
- Payment states: `creating`, `create_failed`, `created`, `processing`, `hold`, `success`, `failure`, `reversed`, `expired`, `removed`.
- Customer notice events: `confirmed`, `rejected`, `paid`, `shipped`, `delivered`; states `pending`, `sending`, `sent`, `uncertain`, `failed`, `skipped`.
- Policy topics: `delivery`, `returns`, `payment`, `hours`.
- Plans (AI replies per UTC month): `trial` 100, `starter` 1000, `growth` 3000, `business` 10000, `unlimited`; optional custom cap.
- Credential kinds: `instagram`, `telegram_bot`, `nova_poshta`, `monobank`, `wayforpay`; statuses `active`, `revoked`, `needs_reconnect`.

---

## 6. Feature detail (how each works today)

### Channels
- **Official Instagram (P1):** owner clicks "Підключити Instagram" → Meta Unified login → callback stores long-lived token encrypted and the account id. Intake by signed webhook or polling (polling is what works in development; Meta sent no real webhook POSTs). Send only inside the 24-hour window; outside it nothing is sent and the shop is notified. One Instagram account can belong to only one shop. Development mode only: testers, no App Review yet.
- **Telegram bot per shop (P2):** owner pastes a BotFather token; server checks `getMe`, registers webhook (needs https `HEPSON_PUBLIC_URL` and the master key). Private chats only; groups, edits, service messages dropped. Media messages not handled.
- **Website chat (F10):** owner enables it, lists allowed site origins, copies the `<script>` snippet. Limits: sessions per IP per hour (20), messages per session per minute (10), per IP per minute (40), per shop per day (2000), 1000 chars per message.
- **Browser connector (Phase 1):** removed 2026-11-06 (D41). Leftover browser profiles under `$HEPSON_DATA_DIR/profiles/` must be deleted by hand.

### Conversations and human takeover
- All channels land in `customers` / `shop_conversations` / `shop_messages`.
- Any member can pause/resume the AI per conversation; a human reply pauses the AI first.
- Escalations ("Потрібна людина") open when the agent cannot answer; members resolve them.
- Per-member unread state, last-message preview ("ШІ:" / "Ви:", attachments), customer note (≤2000 chars, never shown to the AI), customer profile card (phone, city, order count and totals).

### Catalog
- Products with variants, SKU unique per shop, stock never below zero, hide/deactivate (no hard delete), Cyrillic-safe search.
- CSV import: upsert by SKU, `;`/`,`/tab, BOM, Ukrainian or English headers, `group` column for variants, all-or-nothing with line-numbered errors, dry run first, 2 MB cap.
- Google Sheets import by share link through the same importer (one tab per run, fake-only).
- Not built: image hosting (products hold external image URLs), product feeds.

### Orders
- AI drafts or (future) manual; approval checks complete checkout data and reduces stock atomically.
- COD path: approve → `cod_confirmed` → TTN created in background → `shipped` → tracking → `delivered` or `returning` → member confirms `returned` (restock once).
- Prepaid path: approve → `awaiting_payment` → Monobank invoice link sent → `paid` (verified event only) → TTN → `shipped` … Unpaid orders cancel after the timeout (default 24 h) with restock; one reminder before (default 6 h).
- Refusal counter per customer (normalized phone): at the shop's limit (default 1) COD is no longer offered.
- `auto_confirm` autonomy: server approves when every check passes and the total is under the shop's limit.
- Sequential per-shop order numbers shown as `№N` everywhere (dashboard, Excel, Telegram, customer texts, payment texts).
- Excel export of orders by period and status.

### Policies (P3)
Four texts (delivery, returns, payment, opening hours), versioned, owner-edited. Empty topic = the AI escalates instead of answering.

### Notifications
- **Team Telegram chat** (operator bot, shop sets chat id): new escalation, new order draft, payment/TTN problems, quota reached.
- **Notification centre** in the dashboard (bell): hand-offs, new orders, payment problems, TTN problems; last 30 days; one `seenAt` per member.
- **Customer notices:** fixed server texts on confirm (COD), reject, paid, shipped, delivered; one attempt each; failures surface on the order card.

### Stats (F9, P8, P10)
Messages by sender, active conversations, new customers, paused conversations, agent runs and tokens, reply rate, escalations (opened, resolved, open now, average resolution time), order drafts by status, approved totals per currency, funnel (conversations → pending → approved → paid → shipped → delivered), order sources (AI vs person, member vs auto-confirm), dense UTC daily series, monthly AI usage vs cap.

### Plans and quotas (P7)
Operator assigns a plan per shop with the admin key; default from `HEPSON_DEFAULT_PLAN` (`starter`). At the cap the agent makes no model call, escalates, sends one holding text and notifies the owner once per month. No billing.

---

## 7. Dashboard: `apps/dashboard` (shop-owner cabinet)

React + Vite, dev port 5174, proxies the API on 8787, built by `pnpm build`. Ukrainian UI. Session token in `localStorage` (`hepson-session`). Polling, no SSE. Styled with `packages/ui` (Geist fonts self-hosted). Hash routing; deep links between pages (open a conversation, an order, a catalog stock filter). Responsive (checked at 1440 and 390 px).

Files: `App.tsx` (auth, shell, nav), `api.ts` (typed client), `ui.tsx` (Panel, Drawer, Avatar, Spark, FunnelRows, Alert, Textarea, Select, toasts), `Notifications.tsx` (bell), `views/*.tsx`, `style.css`.

### Screens

**Login / registration** — email, name (registration), password ≥10 chars. Logo links back to the website (`VITE_SITE_URL`).

**Shop creation** — name and slug (`lavka-sofii`-style). Shop switcher in the sidebar with "add shop".

**Shell** — sidebar nav with six sections, unread count on "Розмови", AI usage meter ("Відповіді ШІ · <місяць>"), AI state pill (ШІ працює / ШІ вимкнено / ШІ недоступний / Ліміт вичерпано), notification bell, logout.

1. **Огляд (Overview)** — greeting by time of day; KPI tiles with sparklines and "порівняно з попередніми 30 днями" (revenue, AI replies, new customers, confirmed orders); "Потребують уваги" (hand-offs, pending drafts, low stock → "До каталогу"); "Останні розмови" with last-message preview; "Воронка продажів". Empty states ("Розмов ще немає. Підключіть канал у Налаштуваннях.", "Усе опрацьовано — нічого не чекає на вас.").
2. **Розмови (Inbox)** — conversation list with search, filters (Усі / Непрочитане / Потрібна людина / ШІ на паузі), channel badges, unread dots; thread view with message bubbles (customer / ШІ-асистент / Менеджер / system), reply box (reply pauses AI), "ШІ відповідає" toggle; customer side panel: profile card, orders of this customer, note ("Нотатка") with save. Marks read while visible. Mobile: list ↔ thread with "До списку".
3. **Замовлення (Orders)** — tabs Усі / Очікують / Чекають оплату / До відправки / У дорозі / Завершені / Закриті; order cards/drawer with №, client, items, sum, delivery and payment, status timeline (`order_events`), payment attempts, customer notice states. Actions: approve, reject, cancel (restock), create/release TTN, create payment link, mark returned, mark refund requested, resolve escalation. Warnings: payment amount mismatch, link not delivered, notice not delivered, TTN in progress. Excel export.
4. **Каталог (Catalog)** — product table (Товар, Варіант, Ціна, Залишок, Статус: В наявності / Мало / Немає / Приховано), search by name or SKU, stock filters, inline stock edit, "Новий товар" (name, SKU, price, stock), import panel "Імпорт з CSV або Google Sheets" with drag-and-drop, preview (dry run), apply, error list, "Як працює імпорт" help.
5. **Статистика (Analytics)** — period picker; sections Повідомлення, ШІ (runs, model requests, tokens in/out, not sent), Передано людині (opened, resolved, open now, average handling time), Воронка, ШІ і люди (daily AI vs human reply bars; drafts by AI vs manager; approvals by person vs auto). Empty state "Даних за період немає".
6. **Налаштування (Settings)** — five tabs:
   - **Канали:** Instagram card (connect / reconnect / disconnect, status badge Підключено / Потрібно підключити знову / Не підключено, errors like "already connected to another shop"); Telegram customer bot (token paste, replace, disconnect); Чат на сайті (enable, allowed domains, snippet "Вставте перед </body>", rotate key).
   - **ШІ-асистент:** Відповідати клієнтам (on/off), Додаткові інструкції, Поведінка асистента, Підтверджувати замовлення автоматично + Ліміт суми, monthly usage meter.
   - **Правила магазину:** four policy texts (Доставка, Повернення та обмін, Оплата, Графік роботи) with versions.
   - **Доставка й оплата:** Нова Пошта (API key, sender city and branch, parcel weight, content description, refusal limit for COD); Оплата карткою · monobank (X-Token, unpaid cancel hours, reminder hours). Warns when the server has no `HEPSON_MASTER_KEY`.
   - **Команда:** members with roles (Власник / Менеджер), add by email with a role (changing a role or removing a member exists in the API only, not in the UI); Сповіщення для команди (Telegram chat id or @channel).
   - Owner-only controls are disabled for managers; the server enforces roles too.

**Notification centre** (bell, `Notifications.tsx`) — list of hand-offs, new orders, payment and TTN problems with links; "Нових подій немає." when empty; marks seen.

---

## 8. Dev console
Removed with the Phase 1 connector (D41).

---

## 9. Public website: `apps/website`

React components prerendered to static HTML (`scripts/prerender.ts`, `entry-server.tsx` / `entry-client.tsx`), dev port 5175, `pnpm build:website` → `apps/website/dist` (12 pages). Ukrainian only (D39). Canonical and Open Graph tags (`head.ts`), sitemap and robots, self-hosted fonts (no Google Fonts requests). Copy in `src/i18n/uk.ts`; page list in `src/routes.ts`; owner facts in `src/site.ts`; animation slots in `src/animations.ts`. Built per the Claude Design "Hepson Home v2" and "Hepson Site" designs.

### Pages

| Path | Page | Content |
|---|---|---|
| `/` | Home | Hero "Асистент, що справді продає." with animated product embed (`HeroEmbed`), CTAs "Створити магазин" / "Подивитися кабінет"; channel strip (Instagram, Telegram, website chat); "Як це працює" three steps (customer writes → AI prepares order → you confirm) with `HowEmbed`; "Можливості" (unified inbox, catalog and stock with CSV/Sheets, shop rules quoted verbatim, Nova Poshta TTN, Monobank payment link); "Контроль" (answers only from catalog and rules, human confirmation or auto under a limit, hand-off, pause, monthly cap and history); final CTA |
| `/features/` | Можливості | Detailed feature list; unbuilt items marked "Скоро" |
| `/pricing/` | Тарифи | Plans trial/starter/growth/business/unlimited with reply caps; prices except trial show "Буде оголошено" |
| `/about/` | Про нас | Mission, principles (verifiable honesty, owner control, official APIs only, money goes straight to the shop), company details; story and team are `TODO` text |
| `/security/` | Безпека | Encrypted keys and tokens, only allow-listed services, no Instagram passwords, no money handling, shop data isolation, data deletion link, vulnerability contact |
| `/contact/` | Контакти | Email / Telegram / phone / security contact — currently placeholders |
| `/legal/privacy/` | Політика конфіденційності | Draft |
| `/legal/terms/` | Публічна оферта / умови | Draft |
| `/legal/refunds/` | Оплата і повернення | Draft |
| `/legal/cookies/` | Cookies | Draft; table of browser storage (`hepson-session`, `hepson-chat-<ключ>`, no cookies) |
| `/legal/data-deletion/` | Видалення даних | Draft; mailto request form (needed for Meta App Review) |
| `404.html` | Not found | — |

Shared: `components/Layout.tsx` (header with nav and "Увійти"/"Почати", mobile menu, footer with product/company/legal/contacts columns, company details placeholder, CTA band with `CtaBg`), `Faq.tsx`, `AnimSlot.tsx`. Legal pages show a "draft, not reviewed by a lawyer" notice while `SITE.legalReviewed` is `false`.

Placeholders still `null` in `src/site.ts`: contacts (email, Telegram, phone, security), legal entity (name, tax id, address), prices for paid plans, OG image file.

---

## 10. Design system: `packages/ui`
Imported by relative path from dashboard and website (D38).
- `styles.css`: colour tokens (ink scale, brand, success/warning/danger), spacing, radii, shadows, typography.
- `components.tsx`: `Icon`, `Button`, `ButtonLink`, `Badge`, `Input`, `Switch`, `IconTile`, `UsageMeter`, `LogoMark`, `Logo`.
- `icons.ts`: inline icon set (Lucide-style paths).
- `embeds/`: animated marketing illustrations `HeroEmbed`, `HowEmbed`, `LoginFlow`, `CtaBg`, shared `motion.ts`.
- `fonts/`: Geist and Geist Mono (OFL), self-hosted.

---

## 11. Scripts (`package.json`)

| Command | Does |
|---|---|
| `pnpm migrate` | Apply SQL migrations |
| `pnpm bootstrap-key [name]` | Create an operator API key (plan fallback route only) |
| `pnpm dev:api` / `pnpm start:api` | Run the API (watch / plain) |
| `pnpm dev:dashboard` / `pnpm dev:console` / `pnpm dev:website` | Front ends |
| `pnpm build` | Build dev console and dashboard |
| `pnpm build:website` | Prerender the website |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` / `pnpm test:browser` | Vitest unit+integration / real Chromium e2e |
| `pnpm openapi` | Regenerate `docs/openapi.json` |
| `pnpm backup [dest]` | Online SQLite backup (mode 0600, skips browser profiles) |
| `pnpm gen-master-key` / `pnpm rewrap-credentials` | Credential master key and rotation |
| `pnpm format` | Prettier (not clean repo-wide; do not run blindly) |

---

## 12. Configuration (environment variable names)

Nothing auto-loads `.env`; run with `tsx --env-file=.env`. Full commented list in `.env.example`.

- Core: `HEPSON_DATA_DIR`, `HEPSON_DB_FILE`, `HEPSON_HOST`, `HEPSON_PORT`, `HEPSON_LOG_LEVEL`, `HEPSON_MAX_MESSAGE_LENGTH`, `HEPSON_PUBLIC_URL`, `HEPSON_DASHBOARD_URL`, `HEPSON_TRUST_PROXY`.
- Users: `HEPSON_ALLOW_REGISTRATION`, `HEPSON_SESSION_TTL_DAYS`, `HEPSON_SMTP_HOST`, `HEPSON_SMTP_PORT`, `HEPSON_SMTP_USER`, `HEPSON_SMTP_PASSWORD`, `HEPSON_SMTP_FROM`.
- AI: `OPENAI_API_KEY`, `HEPSON_OPENAI_MODEL`, `HEPSON_OPENAI_BASE_URL`.
- Team notifications: `HEPSON_TELEGRAM_BOT_TOKEN`, `HEPSON_TELEGRAM_API_BASE_URL`.
- Operator alerts: `HEPSON_ALERT_TELEGRAM_CHAT_ID`, `HEPSON_ALERT_TELEGRAM_BOT_TOKEN`, `HEPSON_ALERT_CHECK_SECONDS`, `HEPSON_ALERT_REMIND_MINUTES`, `HEPSON_ALERT_DISK_FREE_MB`, `HEPSON_ALERT_URLS`, `HEPSON_WATCHDOG_URL`, `HEPSON_WATCHDOG_SECONDS`.
- Website chat limits: `HEPSON_WEBCHAT_SESSIONS_PER_IP_HOUR`, `HEPSON_WEBCHAT_MESSAGES_PER_SESSION_MINUTE`, `HEPSON_WEBCHAT_MESSAGES_PER_IP_MINUTE`, `HEPSON_WEBCHAT_DAILY_MESSAGES_PER_SHOP`, `HEPSON_WEBCHAT_SESSION_DAYS`.
- Credentials: `HEPSON_MASTER_KEY`, `HEPSON_MASTER_KEY_VERSION`, `HEPSON_MASTER_KEY_PREVIOUS`, `HEPSON_MASTER_KEY_PREVIOUS_VERSION`.
- Meta/Instagram: `HEPSON_META_APP_ID`, `HEPSON_META_APP_SECRET`, `HEPSON_META_CONFIG_ID`, `HEPSON_META_VERIFY_TOKEN`, `HEPSON_META_API_VERSION` (v26.0), `HEPSON_META_GRAPH_BASE_URL`, `HEPSON_META_AUTHORIZE_URL`, `HEPSON_INSTAGRAM_POLL_SECONDS`.
- Nova Poshta: `HEPSON_NOVA_POSHTA_BASE_URL`, `HEPSON_NOVA_POSHTA_POLL_MINUTES`.
- Monobank: `HEPSON_MONOBANK_BASE_URL`, `HEPSON_PAYMENT_CHECK_MINUTES`.
- Plans: `HEPSON_DEFAULT_PLAN`.
- Egress: `HEPSON_EGRESS_EXTRA_HOSTS`.
- Front ends (Vite): `VITE_SITE_URL`, `VITE_DASHBOARD_URL`, `VITE_API_URL`.

---

## 13. Tests

`pnpm test` — 438 tests in 35 files (2026-11-06).
- **Unit (16):** catalog, catalog-import, conversations, credentials, egress, google-sheets, guard, instagram-graph, monobank, notifier, nova-poshta, openai-client, orders, shops, website, xlsx.
- **Integration (19, `app.inject`):** auth-shops, catalog-analytics, catalog-api, checkout-delivery, conversations-api, customer-notices, drop-phase1, instagram, instagram-connect-race, instagram-http, instagram-ingest-recovery, p10-parity, payments, plans, policies, sales-agent, takeover-stats, telegram, web-chat.
- **E2E (`pnpm test:browser`, 2 tests):** web-chat-widget (real Chromium).
- **Fixtures:** `fake-monobank.ts`, `fake-nova-poshta.ts` (written from public docs), `scripted-llm.ts`.
- No automated dashboard UI tests.

---

## 14. Not built / open

- Instagram: real webhook delivery (Meta sends none in dev), App Review / Advanced Access, Business Verification, media attachments, auto-pause when the owner replies from the Instagram app.
- Telegram: live disconnect / blocked / revoked checks, media messages.
- Nova Poshta and Monobank: no live run yet. WayForPay: not built. Courier/address delivery and other carriers: not supported.
- P9 live checks: Instagram attachment CDN host, `share`/`ig_post` URL contents, photo score thresholds on a real catalog.
- WayForPay (deferred, D44).
- Website: real contacts, legal entity, prices, lawyer review of legal texts, OG image, hosting/domain, About story/team. "Увійти" hidden in the header at ≤400px.
- Billing for Hepson itself, refunds automation (refunds stay human).
- Dashboard: manual order creation/editing, password reset, member role change/removal UI, limited product/variant editing, no live updates (polling).
- Infra: no durable queue between ingest and agent; single SQLite file; no deployment/hosting set up.
- Repo hygiene: pnpm lockfile missing `apps/website`; Prettier not clean on several files; `ROADMAP.md` W1 row and `OVERVIEW.md` header are stale.
- Known behaviour trade-off: a payment/TTN problem may reappear as unread in the notification centre if the order row is updated later (D40).

---

## 15. History (commits)

| Date | Commit | What |
|---|---|---|
| 2026-10-28 | `3f3205c`…`ba67d37` | Phase 1 connector: mock, API, console, browser adapter, selectors calibrated live |
| 2026-10-29 | `c605198`, `882b452`, `e096a79`, `0cd1ae6` | F1–F12 SaaS layer, dashboard, docs D1–D28, pivot D22 |
| 2026-10-30 | `ed474f0`…`36624dd` | P1 credential vault, official Instagram via Unified login, webhook hardening, polling (D29, D30) |
| 2026-10-31 | `f0d1cb4`, `ecbb1d5`, `039c56e` | Docs cleanup, P2 Telegram, P3 policies + P4 Nova Poshta |
| 2026-11-01 | `41d18eb`…`31ff0d5` | P5 Monobank, P6 notices, P7 quotas, P8 Sheets/Excel/funnel, P9 suggestions, W1 website structure |
| 2026-11-02 | `e3ff517`, `cf26c6d`, `86c9875` | Design system, Dashboard v3, Home v2 (D38); Russian removed (D39) |
| 2026-11-04 | `f73a3a6`, `87349cd` | Website inner pages, footer, CTA; P10 dashboard parity (D40) |
| 2026-11-06 | (this branch) | Phase 1 browser connector removed (D41) |
