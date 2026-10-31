# AI Handoff

Updated: 2026-10-31T21:01:38Z
Base commit: ecbb1d5439788e392fa0ecd4853bec6b00a5ac5a
Branch: main
Working tree: uncommitted P3 + P4. Modified: `apps/api/src/{server.ts,config.ts,agent/{guard,prompt,sales-agent,tools}.ts,routes/{ai,orders}.ts,services/notifier.ts}`, `apps/dashboard/src/views/{Orders,Settings}.tsx`, `packages/database/src/{agent,index,orders,schema,stats}.ts`, migrations `meta/_journal.json`, `tests/integration/{sales-agent,takeover-stats}.test.ts`, `tests/unit/{guard,orders}.test.ts`, `.env.example`, `docs/{API,DECISIONS,LIMITATIONS,OVERVIEW,ROADMAP}.md`, `docs/openapi.json`. New: `apps/api/src/routes/{delivery,policies}.ts`, `apps/api/src/services/{delivery,nova-poshta}.ts`, `packages/database/src/{delivery,order-kinds,policies}.ts`, migration `0012_policies_checkout` (+ snapshot), `tests/fixtures/fake-nova-poshta.ts`, `tests/integration/{checkout-delivery,policies}.test.ts`, `tests/unit/nova-poshta.test.ts`. The commit hash alone cannot prove this snapshot is current. Nothing pushed.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop AI sales assistant. It has three customer channels: official Instagram (`instagram-official`), Telegram (one bot per shop) and website chat. Each writes into the shop tables and calls `SalesAgent.trigger`. Replies pass the guard (`agent/guard.ts`) and are sent through `services/shop-sender.ts`.

P3 and P4 added:
- **Policies:** `PolicyRepository` (`shop_policies`).
- **Nova Poshta:** `NovaPoshtaApi` (HTTP client over egress), `DeliveryService` (key connect, lookups, TTN creation, tracking poll) and `DeliveryRepository` (sender settings, refusal count).
- **Order lifecycle:** the D25 lifecycle in `OrderRepository`, with an `order_events` audit table.
- **Agent tools:** `get_policy`, `find_np_city`, `find_np_branch`, `get_checkout_options`, `get_order_status`; `create_order_draft` now takes structured checkout data.

Shop secrets are kept only in `CredentialVault`, kinds `telegram_bot` and `nova_poshta`. All outbound HTTP goes through `createEgress`. The Phase 1 browser adapter is frozen.

Code map: `docs/OVERVIEW.md`. Decisions: `docs/DECISIONS.md` D1–D31; D31 records the P3/P4 choices.

## Implemented state

F1–F12 and P1–P4 are built. P3 and P4 are tested only against mocks. P5–P9 and D16 auto-pause are not built.

- **P3:**
  - The owner edits four versioned texts: delivery, returns, payment, hours.
  - The guard blocks periods, clock hours and topic wording unless the same run returned matching policy text. Payment wording is also backed by `get_checkout_options`.
  - A topic with no text leads to an escalation.
- **P4, connect:** the owner pastes the NP key. Hepson reads the sender and contact from NP and stores the key encrypted. The owner then picks the sender branch.
- **P4, checkout:** the draft accepts NP refs only if a lookup returned them in the same run. Approval requires complete checkout data.
- **P4, lifecycle:**
  - Approval moves the order to `cod_confirmed` or `awaiting_payment`.
  - A COD order gets its TTN in the background, at most once. `shipped` means the TTN exists.
  - If NP gives no answer, the order is `uncertain`: a member releases it before a retry.
  - Tracking maps 9/10/11/106 to `delivered`, 102/103 to `returning` plus a refusal, and 105 to `returning` with no refusal.
  - A member confirms `returned`, which restocks once. `cancel` before shipping restocks.
- **P4, refusal limit:** at the shop's limit, COD is refused server-side.
- **`auto_confirm` (D26):** owner-only. The last change records time and user.
- **Dashboard:** cards for policies, Nova Poshta and autonomy; the Orders view has the new statuses and actions.

## Decisions and environment

Runtime: Node >=22 (dev 24), pnpm, TypeScript, Fastify, SQLite/Drizzle.

New variables: `HEPSON_NOVA_POSHTA_POLL_MINUTES` (default 60, 0 = off) and `HEPSON_NOVA_POSHTA_BASE_URL`. P2 and P4 need `HEPSON_MASTER_KEY`; P2 also needs an https `HEPSON_PUBLIC_URL`.

Nothing auto-loads `.env`. `~/.config/hepson/run-api.sh` loads `.env`, `api.env` and `tunnel.env`.

Choices made in code (owner may revisit):
- Without NP there are no AI drafts.
- Prepaid is off by default and stops at `awaiting_payment` until P5.
- Agent limits are now 8 steps and 12 tool calls.

Live test bot: `@hempson_bot`, which is also the operator notifier bot. A Cloudflare quick tunnel and the API from the previous session may still be running. That API runs the old code; migration `0012` applies on restart.

## Validation

Run 2026-10-31, after the P3/P4 changes:
- `pnpm typecheck`: passed.
- `pnpm test`: passed, 413 tests in 31 files.
- `pnpm build`: passed.
- `pnpm openapi`: regenerated.

Not run:
- `pnpm test:browser`.
- A visual check of the dashboard.
- Migration `0012` on the existing dev database (only fresh DBs).
- Any live NP call. The NP fixtures are written from documentation.

## Known issues and uncertainties

- Not verified live: NP method and field shapes, the refused-key error, phone formats and the tracking codes.
- NP has no idempotency key and Hepson has no lookup of existing waybills, so an `uncertain` attempt needs a person to check.
- The guard is a heuristic. Claims worded without numbers or the listed words can pass.
- Telegram not verified live: disconnect/`deleteWebhook`, real 403/401 responses, media messages.
- Instagram: no real webhooks arrive, and the poll fails with Meta code 200. Set aside at the owner's request.
- No durable dispatch queue. An uncertain-send echo may create a duplicate `human` row.
- `~/.config/hepson/api.log` may contain secrets.

## Next actions

1. Review and commit P3+P4. Suggested message: `feat: shop policies (P3), checkout and Nova Poshta (P4)`.
2. Restart the API and confirm migration `0012` applies to the dev DB.
3. Live NP check with a test-cabinet key: connect, pick the sender branch, one COD chat order, TTN created, tracking advances. Capture real responses and replace the doc-based fixtures in `tests/fixtures/fake-nova-poshta.ts`.
4. Check the new dashboard cards in a browser. Run `pnpm test:browser`.
5. Start P5 (Monobank payment links, D24): it unblocks prepaid orders and TTNs from `paid`.
