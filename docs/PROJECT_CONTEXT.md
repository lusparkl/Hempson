# Hepson project context

## Vision and positioning (updated 2026-10-29, D22)
Hepson is a Ukrainian-first B2B SaaS AI sales assistant for online shops (initially clothing, shoes, accessories; keep the model category-neutral). It answers customer questions from verified product and policy data, prepares orders, and carries them from message to paid order to Nova Poshta waybill (TTN). Shop members monitor chats, pause the AI, take over and review orders; owners manage products, policies, channels, team and AI settings in a web dashboard. Multi-tenant: independent shops.

**Direction.** Compete with NovaSale on official APIs only. Instagram through Meta's official API (D23), Telegram through the Bot API (D27), a website chat widget (built, D19). The Phase 1 browser-based Instagram connector is frozen and deprecated (D22).

### Competitor: NovaSale (novasale.app)
Ukrainian AI-CRM for e-commerce: "an AI manager that sells in Instagram, from message to waybill (TTN)". A Meta Tech Provider on the official API. Today it ships:
- Channels: Instagram and Telegram, one shared conversation history per customer.
- Agent: product search by text or customer photo, reads a forwarded Instagram post, FAQ from a shop knowledge base, alternatives and upsell when a size is out of stock, collects the delivery address, sends a WayForPay or Monobank payment link or offers cash on delivery, creates a Nova Poshta TTN and reports delivery status, hands off to a manager with context.
- Storefront: public catalog with variants, cart and checkout (Nova Poshta, online payment or COD), custom domain, GA4/GTM/Meta Pixel.
- CRM and ops: chats, orders, customers, products, analytics, full funnel, AI vs manager performance, an "AI analyst" for owners, team roles, CSV/XLSX/Google Sheets import, Excel export.
- Pricing (as given in the owner's brief, unverified by us): storefront-only about 528 UAH/month; Starter about 2,156 (150 products, 1,000 AI replies); Growth about 4,356 (adds online payments); Business about 8,756 (5 shops, analytics); Enterprise about 21,956. Plans are capped by AI replies per month.

### Where Hepson wins (product principles, not marketing)
1. **Verifiable honesty.** The reply guard blocks any price or stock figure that no tool returned. The same rule extends to policies, delivery dates and payment state (P3-P5): the AI states only what a server tool returned in that run.
2. **Owner control.** Per-shop autonomy (D26): order drafts need human approval (default), or auto-confirm only when server-verified stock, totals and checkout checks pass.
3. **Lower entry price and a website chat widget** alongside DMs.

## Scope and autonomy
- Primary language Ukrainian (`uk`); per-shop language/tone later. Default currency UAH.
- The AI answers questions, collects checkout data and creates order drafts. Confirmation follows the shop's autonomy setting (D26). **The AI never handles money or card data**: it relays a payment link the server created with the shop's own acquiring credentials (D24). The AI never refunds, never marks an order paid, never creates a TTN by itself; those are server actions from verified events or human decisions. Unknown facts, unusual requests and sensitive decisions escalate to a human.
- AI provider: OpenAI API behind a provider-neutral interface. The server runs and validates tool calls; model output is never authoritative for price, stock, policy, delivery date or payment state. Secrets only via env (operator secrets) or the encrypted per-shop credential store (D28), never committed.

## Constraint: no registered business (FOP) yet
Meta Business Verification and App Review for Advanced Access need a business; Hepson's own subscription billing too. Until then:
- The Meta app runs in Development mode with Standard Access. That works only for Instagram professional accounts with a role on the app: the owner's own account and a few pilot shops added as Instagram testers with their written consent. Messages from arbitrary customers of arbitrary shops cannot be served yet.
- Telegram, the website chat, Nova Poshta, Monobank and WayForPay (each with the **shop's** own merchant account) need no business registration on Hepson's side, so P2-P5 are unaffected.
- Hepson charges no one yet; plans and quotas (P7) are enforced limits without billing.
- Design rule: moving to Advanced Access is configuration (app credentials, approved scopes), not a rewrite.

## Architecture (modular monolith)
- Phase 1 (done, **frozen**, D22): Instagram Direct connector via browser. Packages `connector-core`, `database`, `mock-adapter`, `instagram-browser`; `apps/api` (Fastify `/v1`, `ConnectorService`); `apps/dev-console`. Kept with its tests; disabled by default since P1 (`HEPSON_ENABLE_BROWSER_ADAPTER`); deleted only after `instagram-official` is live-verified. See `AGENTS.md`.
- Phase 2 (built, F1-F12): shops, auth, catalog, conversations, OpenAI agent with narrow tools, order drafts, takeover, Telegram operator notifications, stats, website chat, owner dashboard.
- Pivot layers (P1 built: official Instagram, credential store, egress guard; P2-P9 planned): channel adapters for Instagram (official) and Telegram (normalize and ingest, no AI logic) · per-shop encrypted credential store (D28) · egress allow-list (D22) · policies tool · checkout data and Nova Poshta · payment links and verified webhooks · order state machine with events (D25) · customer notifications · quotas · imports/exports and funnel analytics.
- DB: SQLite via better-sqlite3 + Drizzle in `packages/database` (D1). All new tables live in the same migration chain.

## Rules
- Hard tenant isolation: every shop-owned table references `shops.id`; never trust a client-supplied shopId without membership authorization; all queries shop-scoped.
- Messages dedupe on channel + external message id; keep direction, sender, delivery result and AI/human attribution; never fabricate delivery acks. `uncertain` sends are never auto-retried.
- Metrics (AI sent vs drafted vs failed vs human, model requests, order transitions) must be derivable from source events.
- Outbound: bounded retries, never duplicate replies. Outbound HTTP only to the allow-list in D22. Log minimally, redact tokens/PII, encrypt per-shop secrets at rest (D28), never return a stored secret from any API.
- Payment state comes only from verified provider events or status calls (D24).
- No public unauthenticated shop operations beyond the signature- or origin-gated ones (website chat D19; Meta, Telegram and payment webhooks). No credential harvesting; do not bypass platform security checks; no scraping.
- No assumed external success: use mocks without keys; document what was not live-tested. Do not call any official-API behavior verified until it ran against the real platform with an authorized account.

## Process
One narrowly scoped feature per session (see `docs/ROADMAP.md`, P-series). At session start read `PROJECT_CONTEXT.md`, `ROADMAP.md`, `DECISIONS.md`, `AI_HANDOFF.md`, then inspect relevant code. At end: tests/typecheck, update docs, stop. Never commit or push without the owner's say-so.
