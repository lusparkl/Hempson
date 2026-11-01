# AI Handoff

Updated: 2026-11-01T18:17:32Z
Base commit: d2e2d441721b2aaac3c4d5aa60bcc16a3c32b46c
Branch: feat/p9-suggestions
Working tree: clean (only this handoff changes once it is saved).

This is a snapshot: if the tree later has uncommitted changes, the commit hash alone cannot prove this file is current. Nothing is pushed. `main` is at `4ed5fc1`, 21 commits ahead of `origin/main`. `feat/p9-suggestions` is one commit ahead of `main` and not merged yet. The old `feat/p3-p4-policies-nova-poshta` branch is fully merged and still exists.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop AI sales assistant that uses official APIs only (D22). Customer channels: official Instagram, Telegram (one bot per shop) and website chat. Each channel writes into the shop tables and calls `SalesAgent.trigger`. Replies pass the guard (`agent/guard.ts`) and go out through `services/shop-sender.ts`.

Agent tools are in `apps/api/src/agent/tools.ts` and the prompt in `agent/prompt.ts`. Shop secrets live only in `CredentialVault` (kinds `telegram_bot`, `nova_poshta`, `monobank`). All outbound HTTP goes through `createEgress`.

Code map: `docs/OVERVIEW.md`. Decisions: `docs/DECISIONS.md` D1–D36. Roadmap: `docs/ROADMAP.md`.

## Implemented state

F1–F12 and P1–P8 are built (P5 Monobank, P6 customer notices, P7 plans, P8 Sheets import, Excel export and funnel; details in D32–D35). Not built: WayForPay, XLSX import, D16 auto-pause.

**P9, suggestions (commit `d2e2d44`, D36).**
- The agent tool `suggest_products(sku, kind, limit ≤ 3)` uses `CatalogRepository.similarProducts` and `boughtTogether` in `packages/database/src/catalog.ts`.
- `alternatives`: other in-stock variants of the same product, plus in-stock products sharing a name word of 3+ letters, ranked by shared words, then by price closeness.
- `complements`: in-stock products that appeared in the same order drafts. Rejected and cancelled drafts don't count.
- Prompt rule 6a: alternatives when a variant is out of stock; at most one complement offer per conversation.

**P9 still to build, in this order:** photo search, forwarded Instagram posts, storefront. The scope decisions are recorded in D36:
- Photo search matches against an index of catalog photos (option B).
- A photo message counts as 1 AI reply.
- Customer images are downloaded, used for that run and deleted; the dashboard shows a placeholder.
- Meta CDN hosts may be added to egress, but only after confirming them from Meta's docs.
- Product images come from the existing `products.media` URLs.
- The storefront is read-only at `HEPSON_PUBLIC_URL/s/<slug>`, and ordering goes through the chat checkout.

## Decisions and environment

- Runtime: Node >=22 (dev 24), pnpm, TypeScript, Fastify, SQLite/Drizzle.
- Variables: `HEPSON_DEFAULT_PLAN`, `HEPSON_PAYMENT_CHECK_MINUTES`, `HEPSON_MONOBANK_BASE_URL`. Webhooks need an https `HEPSON_PUBLIC_URL`. P2, P4 and P5 need `HEPSON_MASTER_KEY`.
- `buildApp` runs migrations on startup. The latest is `0015`. P9 added no migration.
- Dev DB `~/.hepson/hepson.db` is at `0015`, verified 2026-11-01 (16 rows in `__drizzle_migrations`, new tables present). The pre-migration copy is `hepson.db.bak-20261101-pre0013`.
- Start the API with `~/.config/hepson/run-api.sh`, which loads `.env`, `api.env` and `tunnel.env`. Last start: 2026-11-01 from `d2e2d44`, port 8787, `/health` ok, as a background task of the Claude session; it may not outlive that session. Its log is in the session scratchpad and may contain secrets.
- Prettier was not clean at HEAD in `catalog.ts`, `tools.ts` and `sales-agent.test.ts` before P9, so I left those files unformatted.

## Validation

Run 2026-11-01 on `d2e2d44`:
- `pnpm typecheck`: passed.
- `pnpm test`: 476 tests passed in 38 files, including 3 new suggestion tests in `tests/integration/sales-agent.test.ts`.

Earlier (P8): console and dashboard builds passed, and `pnpm openapi` was regenerated.

Not run:
- `pnpm test:browser`.
- A visual check of the dashboard.
- Any live check of Nova Poshta, Monobank or Google Sheets.
- Microsoft Excel.
- Suggestions with a real LLM. They are tested only with the scripted model.

## Known issues and uncertainties

- **Photo search option B.** OpenAI has no known image-embedding endpoint. The candidates are a local open-source image model (a new dependency) or vision captions of catalog images plus text embeddings. Check the current OpenAI docs first. Any non-OpenAI paid service needs owner approval.
- **Built from documentation only, not live-checked:** Monobank, Nova Poshta response shapes, and the Google Sheets redirect.
- **Instagram.** Webhooks don't arrive (polling is used, D30). Shipping and delivery notices mostly fall outside the 24-hour window.
- **Heuristics and limits.** The guard is a phrase list and does not check product names. The P7 cap counts replies, not cost. Similar-product matching is by name words only (there is no category field).
- **Operations.** There is no durable reply queue. `api.log` may contain secrets.

## Next actions

1. Merge `feat/p9-suggestions` into `main` with `git merge --ff-only`. Then decide whether to push `main` (22 commits) and delete the merged branches.
2. Check the dashboard Stats, Orders and Catalog views in a browser. Assign plans if needed: `PUT /v1/shops/:id/plan` with the admin key.
3. Try one real-LLM conversation with an out-of-stock variant, and confirm the suggestion behaviour and the guard.
4. P9 photo search:
   - Choose the index source (see the first known issue).
   - Download Telegram photos through egress, in memory only.
   - Index from the `products.media` URLs.
   - Count the run as 1 reply.
   - Show a dashboard placeholder for the image.
   - Done when: tests cover a photo match, no image file is written, and egress refuses unknown hosts.
5. Then forwarded Instagram posts (Meta CDN hosts from the docs), the storefront, and the live checks: Monobank test token, Nova Poshta key, one Google Sheet, `pnpm test:browser`.
