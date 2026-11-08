# AI Handoff

Updated: 2026-11-08T18:26:29Z
Base commit: 2d82cd9771dc914310efdb9b6532dcb43a9d6a34
Branch: main (level with `origin/main`; no other branches)
Working tree: uncommitted password reset and team UI: `.env.example`, `package.json`, `pnpm-lock.yaml`, `apps/api/src/{config,server}.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/auth/reset.ts` (new), `apps/api/src/services/mailer.ts` (new), `apps/dashboard/src/App.tsx`, `apps/dashboard/src/views/Settings.tsx`, `packages/database/src/{auth,schema}.ts`, `packages/database/src/migrations/` (`0019` new), `scripts/reset-link.ts` (new), `tests/integration/password-reset.test.ts` (new), `docs/{DECISIONS,INVENTORY,LIMITATIONS}.md`

This is a snapshot: the uncommitted content cannot be proven current by the commit hash alone.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop AI sales assistant on official APIs only (D22). Channels (official Instagram, Telegram bot per shop, website chat) write into shop tables and call `SalesAgent.trigger`; replies pass `agent/guard.ts` and leave via `services/shop-sender.ts`. Secrets only in `CredentialVault`; outbound HTTP only via `createEgress`. Code map: `docs/OVERVIEW.md`, `docs/INVENTORY.md`. Decisions D1–D46 in `docs/DECISIONS.md`; roadmap in `docs/ROADMAP.md`.

Frontends: `apps/dashboard` (port 5174, proxies API 8787), `apps/website` (prerendered, Ukrainian only, D37/D39). Shared design system `packages/ui/src` (D38).

## Implemented state

- P0–P10 and W1 built per ROADMAP; WayForPay deferred (D44), Monobank only.
- P8 XLSX import (D43). P9 photo search, forwarded posts, storefront `/s/<slug>` (D42).
- AI playground: `POST /v1/shops/:shopId/ai/playground`, `views/Playground.tsx`; sandboxed.
- One money format `moneyShort`; storefront restyled, light theme only.
- Website demo (D45, committed `2d82cd9`): page `/demo/` (`pages/Demo.tsx`), `routes/demo.ts`, `services/demo.ts` seeds the memberless shop `hepson-demo`. Off unless `HEPSON_DEMO` is set. Runs the playground; no custom instructions. Limits: 20 turns per IP per hour, 300 per day, in memory. No Nova Poshta key, so no order can complete. Styling is functional only.
- Password reset (D46, uncommitted): `/v1/auth/password-reset/{request,confirm}`, table `password_resets`, one-time 1-hour link in the URL fragment (`#reset=`), revokes all sessions. SMTP via `services/mailer.ts`; without SMTP the dashboard says to contact support and `pnpm reset-link <email>` prints a link.
- Team tab (uncommitted): owners change roles and remove members, any member can leave, sole owner gets no controls. The member API already existed.

## Decisions and environment

- Node >=22 (dev 24), pnpm, TypeScript strict, Fastify 5, Zod 4, SQLite/Drizzle, React/Vite, Vitest. New: `nodemailer`.
- Commands: `pnpm typecheck`, `pnpm test`, `pnpm test:browser`, `pnpm build`, `pnpm build:website`, `pnpm migrate`, `pnpm dev:api`, `pnpm dev:dashboard`, `pnpm dev:website` (5175), `pnpm exec drizzle-kit generate --name X`, `pnpm reset-link <email>`.
- Main variables (names only): `OPENAI_API_KEY`, `HEPSON_OPENAI_MODEL`, `HEPSON_MASTER_KEY`, `HEPSON_PUBLIC_URL`, `HEPSON_DASHBOARD_URL`, `HEPSON_TRUST_PROXY`, `HEPSON_DATA_DIR`, `HEPSON_DEMO`, `HEPSON_DEMO_ORIGINS`, `HEPSON_DEMO_TURNS_PER_IP_HOUR`, `HEPSON_DEMO_TURNS_PER_DAY`, `HEPSON_SMTP_HOST`, `HEPSON_SMTP_PORT`, `HEPSON_SMTP_USER`, `HEPSON_SMTP_PASSWORD`, `HEPSON_SMTP_FROM`, `HEPSON_PHOTO_SEARCH`, `HEPSON_EGRESS_EXTRA_HOSTS`, `VITE_SITE_URL`, `VITE_DASHBOARD_URL`, `VITE_API_URL`.
- Communicate with the user in English. Do not suggest save-context.

## Validation

2026-11-08, on the current working tree: `pnpm typecheck` 0 errors; `pnpm test` 490 passed (42 files).

Run just before a final one-string quote change in `routes/auth.ts`: `pnpm test:browser` 2 passed; `pnpm build` and `pnpm build:website` OK.

Ad-hoc Chromium runs with fakes (not in the repo): `/demo/` with a fake model at 1440 and 390 px; reset and team flows with a fake SMTP server, no console errors.

Not run: real OpenAI demo replies, a real SMTP server, the dashboard test chat after its `scrollIntoView` fix, a browser check of `/s/<slug>`, any real-platform check.

## Known issues and uncertainties

- Storefront and dashboard round kopecks: 50.50 shows as `51 ₴`, which can differ from the amount charged.
- Demo spending is controlled only by in-memory limits that reset on restart; the Origin check is not authentication. Behind a proxy, `HEPSON_TRUST_PROXY` is needed or visitors share one IP limit.
- The privacy page does not mention demo messages going to OpenAI; only the demo page does.
- Email deliverability (SPF, DKIM) is unknown. Reset limits are in memory.
- Photo-search thresholds are uncalibrated (D42). Instagram photo download is refused until a live capture gives the CDN host. XLSX reader is untested on real exported files (D43).
- Payment/TTN problem may reappear unread after a later order row update (D40).
- Browser profiles under `$HEPSON_DATA_DIR/profiles/` hold Instagram session cookies; the operator deletes them by hand (D41).
- Prettier is not clean on some files, including `apps/api/src/routes/auth.ts` and `packages/database/src/auth.ts` (already so at `HEAD`).

## Next actions

1. Commit the password reset and team UI when the user asks; run `pnpm migrate` where deployed.
2. Configure SMTP and `HEPSON_DASHBOARD_URL`; confirm a reset email arrives from a real server.
3. Enable the demo with a real model and an OpenAI spending cap; set `HEPSON_DEMO_ORIGINS` and `VITE_API_URL` for production.
4. Check `/s/<slug>` at 1440 and 390 px; decide whether non-whole prices show kopecks (`routes/storefront.ts`, `moneyShort` in `apps/dashboard/src/api.ts`).
5. Live checks: P1 webhook delivery, P2 disconnect, P4 Nova Poshta, P5 Monobank test token, Google Sheets fetch, Instagram media capture (`docs/LIMITATIONS.md`).
6. Owner fills `apps/website/src/site.ts` and adds the Open Graph image; lawyer reviews legal texts, including the demo's OpenAI processing; hosting.
