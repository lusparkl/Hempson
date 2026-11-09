# AI Handoff

Updated: 2026-11-08T18:39:45Z
Base commit: fbce1ab29dd35ce81008737d80763c3d23892963
Branch: main (level with `origin/main`; `feat/website-design-sync` is merged and still exists locally and on origin)
Working tree: clean

Uncommitted content, if any appears later, is a snapshot and cannot be proven current by the commit hash alone.

## Purpose and architecture

Hepson is a Ukrainian-first multi-shop AI sales assistant on official APIs only (D22). Channels (official Instagram, Telegram bot per shop, website chat) write into shop tables and call `SalesAgent.trigger`; replies pass `agent/guard.ts` and leave via `services/shop-sender.ts`. Secrets only in `CredentialVault`; outbound HTTP only via `createEgress`. Code map: `docs/OVERVIEW.md`, `docs/INVENTORY.md`. Decisions D1–D46 in `docs/DECISIONS.md`; roadmap in `docs/ROADMAP.md`.

Frontends: `apps/dashboard` (port 5174, proxies API 8787), `apps/website` (prerendered, Ukrainian only, D37/D39, port 5175). Shared design system `packages/ui/src` (D38). Website copy lives in `apps/website/src/i18n/uk.ts`; owner facts in `apps/website/src/site.ts`.

## Implemented state

- P0–P10 and W1 built per ROADMAP; WayForPay deferred (D44), Monobank only.
- P8 XLSX import (D43). P9 photo search, forwarded posts, storefront `/s/<slug>` (D42).
- AI playground: `POST /v1/shops/:shopId/ai/playground`, `views/Playground.tsx`; sandboxed.
- One money format `moneyShort`; storefront restyled, light theme only.
- Website demo (D45): page `/demo/`, `routes/demo.ts`, `services/demo.ts` seeds the memberless shop `hepson-demo`. Off unless `HEPSON_DEMO` is set. Limits: 20 turns per IP per hour, 300 per day, in memory. No Nova Poshta key, so no order can complete.
- Password reset (D46): `/v1/auth/password-reset/{request,confirm}`, table `password_resets`, one-time 1-hour link in the URL fragment, revokes all sessions. SMTP via `services/mailer.ts`; without SMTP, `pnpm reset-link <email>` prints a link.
- Team tab: owners change roles and remove members, any member can leave, sole owner gets no controls.
- Website design sync (`fbce1ab`), from the Claude Design project at `https://claude.ai/code/artifact/3ef3d32a-1aa6-42fb-aa94-2de2f69f0242`: navbar with the same five links on every page and a `<details>` burger menu at 960 px and below; Home with photo search, storefront and analytics cards; Demo and Pricing restyled; footer Product links updated, footer inside the page rails on Home only. `packages/ui` gained the `menu` icon and `.hs-bars`.
- About, Security, Contact and legal pages were not re-compared with the design.

## Decisions and environment

- Design placeholders deliberately not copied: plan prices (`PRICING`, undecided), `SITE.contacts`, `SITE.legalEntity`, and the FAQ claim about recalculating the month's difference (not built). Demo keeps the sentence saying OpenAI processes messages, which the design dropped. Money stays `1 280 ₴`, not `1280.00 UAH`.
- Node >=22 (dev 24), pnpm, TypeScript strict, Fastify 5, Zod 4, SQLite/Drizzle, React/Vite, Vitest, `nodemailer`.
- Commands: `pnpm typecheck`, `pnpm test`, `pnpm test:browser`, `pnpm build`, `pnpm build:website`, `pnpm migrate`, `pnpm dev:api`, `pnpm dev:dashboard`, `pnpm dev:website`, `pnpm exec drizzle-kit generate --name X`, `pnpm reset-link <email>`.
- Main variables (names only): `OPENAI_API_KEY`, `HEPSON_OPENAI_MODEL`, `HEPSON_MASTER_KEY`, `HEPSON_PUBLIC_URL`, `HEPSON_DASHBOARD_URL`, `HEPSON_TRUST_PROXY`, `HEPSON_DATA_DIR`, `HEPSON_DEMO`, `HEPSON_DEMO_ORIGINS`, `HEPSON_DEMO_TURNS_PER_IP_HOUR`, `HEPSON_DEMO_TURNS_PER_DAY`, `HEPSON_SMTP_HOST`, `HEPSON_SMTP_PORT`, `HEPSON_SMTP_USER`, `HEPSON_SMTP_PASSWORD`, `HEPSON_SMTP_FROM`, `HEPSON_PHOTO_SEARCH`, `HEPSON_EGRESS_EXTRA_HOSTS`, `VITE_SITE_URL`, `VITE_DASHBOARD_URL`, `VITE_API_URL`.
- Communicate with the user in English. Do not suggest save-context.

## Validation

2026-11-08, on the content of `fbce1ab`: `pnpm typecheck` 0 errors; `pnpm test` 490 passed (42 files); `pnpm build:website` OK.

Run just before the footer change and a Prettier pass on `Home.tsx` and `Demo.tsx`: `pnpm test:browser` 2 passed; `pnpm build` OK.

Ad-hoc Chromium runs (scripts not in the repo): Home, Demo, Pricing at 1440, 1024, 800, 390 px with a stubbed demo API; footer at 1440 and 390 px. No horizontal overflow or console errors; menu opens and closes on link click.

Not run: real OpenAI demo replies, a real SMTP server, a browser check of `/s/<slug>`, any real-platform check.

## Known issues and uncertainties

- `/features/` is no longer linked from anywhere on the site; it remains prerendered and in the sitemap.
- Storefront and dashboard round kopecks: 50.50 shows as `51 ₴`, which can differ from the amount charged.
- Home storefront sample shows `hepson.ua/s/linen-home`; ownership of that domain is unknown.
- Demo spending is controlled only by in-memory limits that reset on restart; the Origin check is not authentication. Behind a proxy, `HEPSON_TRUST_PROXY` is needed or visitors share one IP limit.
- The privacy page does not mention demo messages going to OpenAI; only the demo page does.
- Email deliverability is unknown. Reset limits are in memory.
- Photo-search thresholds are uncalibrated (D42). Instagram photo download is refused until a live capture gives the CDN host. XLSX reader is untested on real exported files (D43).
- Payment/TTN problem may reappear unread after a later order row update (D40).
- Browser profiles under `$HEPSON_DATA_DIR/profiles/` hold Instagram session cookies; the operator deletes them by hand (D41).
- Prettier is not clean on `apps/api/src/routes/auth.ts` and `packages/database/src/auth.ts`.

## Next actions

1. Run `pnpm migrate` where deployed (migration `0019`).
2. Decide `/features/`: remove it or link it again.
3. Decide plan prices in `apps/website/src/site.ts`; keep them equal to server caps (`tests/unit/website.test.ts`).
4. Configure SMTP and `HEPSON_DASHBOARD_URL`; confirm a reset email arrives from a real server.
5. Enable the demo with a real model and an OpenAI spending cap; set `HEPSON_DEMO_ORIGINS` and `VITE_API_URL` for production.
6. Check `/s/<slug>` at 1440 and 390 px; decide whether non-whole prices show kopecks (`routes/storefront.ts`, `moneyShort` in `apps/dashboard/src/api.ts`).
7. Live checks: P1 webhook delivery, P2 disconnect, P4 Nova Poshta, P5 Monobank test token, Google Sheets fetch, Instagram media capture (`docs/LIMITATIONS.md`).
8. Owner fills `apps/website/src/site.ts` and adds the Open Graph image; lawyer reviews legal texts, including the demo's OpenAI processing; hosting.
