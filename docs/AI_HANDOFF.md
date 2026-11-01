# AI Handoff

Updated: 2026-11-01T11:06:51Z
Base commit: 039c56e3841ef7691ce6c66071d812528c88fdd2
Branch: feat/p3-p4-policies-nova-poshta
Working tree: uncommitted P5 (Monobank).
- Modified: `apps/api/src/{server,config}.ts`, `apps/api/src/agent/{guard,prompt,sales-agent,tools}.ts`, `apps/api/src/routes/orders.ts`, `apps/api/src/services/{delivery,notifier,shop-sender}.ts`, `apps/dashboard/src/views/{Orders,Settings}.tsx`, `packages/database/src/{delivery,index,order-kinds,orders,schema}.ts`, migrations `meta/_journal.json`, `tests/unit/{guard,orders}.test.ts`, `.env.example`, `docs/{API,DECISIONS,LIMITATIONS,OVERVIEW,ROADMAP}.md`, `docs/openapi.json`.
- New: `apps/api/src/routes/payments.ts`, `apps/api/src/services/{monobank,payments}.ts`, `packages/database/src/payments.ts`, migration `0013_payments` (+ snapshot), `tests/fixtures/fake-monobank.ts`, `tests/integration/payments.test.ts`, `tests/unit/monobank.test.ts`.

This is a snapshot; the commit hash alone cannot prove it is current. Nothing is pushed. Local `main` is 17 commits ahead of `origin/main`. The P3/P4 branch is not merged.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop AI sales assistant. Its customer channels are official Instagram, Telegram (one bot per shop) and website chat. Each channel writes into the shop tables and calls `SalesAgent.trigger`. Replies pass the guard (`agent/guard.ts`) and are sent through `services/shop-sender.ts`.

Shop secrets live only in `CredentialVault`, with kinds `telegram_bot`, `nova_poshta` and `monobank`. All outbound HTTP goes through `createEgress`.

Code map: `docs/OVERVIEW.md`. Decisions: `docs/DECISIONS.md` D1–D32.

## Implemented state

F1–F12 and P1–P5 (Monobank only) are built. P3–P5 are tested only against mocks. Not built: WayForPay, P6–P9, D16 auto-pause.

**P5:**
- **Connect.** The owner pastes the acquiring token. Hepson calls `details`, then `pubkey`, then stores the token in the vault. Each connection gets a fresh opaque webhook id. Prepaid is offered only when `prepaidEnabled` is on and a `monobank` credential is active (`DeliveryRepository.paymentProviderReady`).
- **Link.** Approval into `awaiting_payment` sets `payment_due_at` (timeout default 24 h). `PaymentService.createLink` claims an `order_payments` row (one active row per order), creates the invoice for the stored total in UAH, and sends a fixed-template `system` message. If the link can't be delivered, the shop is notified with it. If invoice creation fails, the row becomes `create_failed` and a member can retry via `POST .../payment-link`.
- **Webhook** `POST /webhooks/monobank/:webhookId`:
  - Signature: `x-sign` ECDSA over the raw body. On failure the public key is refreshed, at most every 10 min.
  - Dedupe and ordering: `payment_events` unique key plus `modifiedDate`/rank ordering.
  - Amount/currency mismatch: escalation, nothing applied.
  - `success`: order to `paid`, then `DeliveryService.afterPaid` starts the TTN.
  - Payment after cancel: flagged and escalated.
  - `failure`: frees the slot. `reversed`: shop is notified.
- **Job** `reconcileOnce` (every `HEPSON_PAYMENT_CHECK_MINUTES`):
  - Status check of open invoices older than 2 min.
  - One reminder 6 h before the deadline.
  - At the deadline: `invoice/remove`, then cancel with restock (`system:timeout`). An invoice still `processing` gets 1 h of grace.
  - A member's cancel also removes the invoice.
- **Agent.** `get_order_status` returns the paid flag and the current link. The guard blocks "paid" claims and payment URLs the tool did not return. The supersede check now ignores server (non-incoming) messages.
- **Refunds.** `POST .../refund-requested` (from `paid` onward) records the request and notifies the shop; the refund itself happens in the Monobank cabinet.
- **Dashboard.** Monobank settings card, plus payment status and actions in Orders.

## Decisions and environment

Runtime: Node >=22 (dev 24), pnpm, TypeScript, Fastify, SQLite/Drizzle.

- New variables: `HEPSON_PAYMENT_CHECK_MINUTES` (default 5, 0 = off) and `HEPSON_MONOBANK_BASE_URL`.
- Webhooks need an https `HEPSON_PUBLIC_URL`; without it, only the status job finds payments. P2, P4 and P5 need `HEPSON_MASTER_KEY`.
- `buildApp` runs migrations on startup. I earlier claimed it did not; that was wrong.
- `~/.config/hepson/run-api.sh` loads `.env`, `api.env` and `tunnel.env`, and is started with output redirected to `~/.config/hepson/api.log`.
- Dev DB `~/.hepson/hepson.db` has migrations through `0012`; there is a backup at `hepson.db.bak-20261101-pre0012`. `0013` applies on the next API start.
- The API started on 2026-11-01 runs pre-P5 code. No tunnel is running.
- Prettier is not clean at HEAD, so changed files were not reformatted.

## Validation

Run 2026-11-01, after the P5 changes:
- `pnpm typecheck`: passed.
- `pnpm test`: passed, 443 tests in 33 files.
- `pnpm build`: passed.
- `pnpm openapi`: regenerated.

Not run:
- `pnpm test:browser`.
- A visual check of the dashboard.
- Any live NP or Monobank call.
- Migration `0013` on the dev DB.

## Known issues and uncertainties

- **Monobank, from docs only.** Unconfirmed: the `merchantPaymInfo` schema (Hepson sends only `reference` and `destination`), the API error body, status meanings, rate limits, and whether a `failure` invoice can still be paid. No fiscal receipts (`basketOrder`/ПРРО) are sent. UAH only.
- **NP.** Response shapes are unverified, and an `uncertain` TTN needs a person to resolve.
- **Guard.** It is a phrase-list heuristic for prices, policies, delivery and paid claims.
- **Telegram and Instagram live gaps** are unchanged; Instagram webhooks still don't arrive.
- **Queues and logs.** There is no durable dispatch queue. `api.log` may contain secrets.

## Next actions

1. Review and commit P5 (suggested: `feat: Monobank payment links (P5)`), then decide whether to merge the branch into `main` or open a PR.
2. Restart the API and confirm `0013` applies.
3. Live Monobank test with a test token from api.monobank.ua: start the tunnel with an https `HEPSON_PUBLIC_URL`, connect, approve one prepaid order, pay with a Luhn-valid card. Confirm the webhook moves the order to `paid` and the TTN is created. Then replace `tests/fixtures/fake-monobank.ts` with captured responses.
4. Live NP check (from P4), the dashboard browser check, and `pnpm test:browser`.
5. Next feature: P6 customer notifications (payment received, shipped), or WayForPay.
