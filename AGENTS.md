# Project instructions

## Architecture
- Purpose: Hepson Instagram Direct connector — provider-agnostic, authenticated local HTTP API (REST + SSE) for reading/sending DMs of shop-owned, owner-authorized Instagram accounts. Phase-2 AI sales manager consumes this API; it is out of scope here.
- Phase 2 (AI sales assistant, multi-shop SaaS) is built feature by feature; read `docs/PROJECT_CONTEXT.md`, `ROADMAP.md`, `DECISIONS.md` and `docs/AI_HANDOFF.md` at session start.
- Runtime: Node >=22 (dev on 24), TypeScript strict, pnpm workspace, Fastify 5, Zod 4, SQLite via better-sqlite3 + Drizzle, Playwright (persistent headed Chromium), Vitest, React/Vite dev console.
- Boundaries: `packages/connector-core` (types, errors, events, fingerprint) · `packages/database` (schema, migrations, `Store`) · `packages/mock-adapter` · `packages/instagram-browser` (ALL Instagram DOM knowledge in `selectors.ts`/`parsers.ts`; profile/lock/login/sender) · `apps/api` (routes, `ConnectorService` worker/send queue, event bus, `agent/` = AI sales agent: tools, reply guard, LLM client) · `apps/dev-console` · `apps/dashboard` (shop owner UI, user sessions) · website chat = `routes/web-chat.ts`, `services/web-chat.ts`, `widget/web-chat.js`.
- Direction (2026-10-29, D22): compete with NovaSale on official APIs only (Instagram API with Unified login, Telegram Bot API, Nova Poshta, Monobank/WayForPay with each shop's own credentials). `packages/instagram-browser` is FROZEN and deprecated: no new work, off by default (`HEPSON_ENABLE_BROWSER_ADAPTER`). Roadmap = P-series in `docs/ROADMAP.md`; all outbound HTTP only through `services/egress.ts` (D22 allow-list). Official Instagram = `services/instagram*.ts` + `routes/instagram.ts`, writes straight to shop tables (channel `instagram-official`); credentials = `CredentialVault` (`packages/database/src/credentials.ts`, no read-back).
- Invariants: one persistent profile dir per account (`$HEPSON_DATA_DIR/profiles/<uuid>`, never deleted except explicit forget); no Instagram password/cookie handling by Hepson; per-shop provider tokens/keys only in the encrypted store (D28), never logged or returned; payment state only from verified provider events (D24); adapters throw only before an irreversible UI action, otherwise return `uncertain` (never auto-retried); every query is accountId-scoped.

## Development commands
- Install: `pnpm install` then `pnpm rebuild better-sqlite3` if the native binding is missing; `pnpm exec playwright install chromium`
- Migrate: `pnpm migrate` (generate new: `pnpm exec drizzle-kit generate`)
- Develop: `pnpm bootstrap-key` once, `pnpm start:api` (or `dev:api`), `pnpm dev:console`, `pnpm dev:dashboard`
- Test: `pnpm test` (unit+integration, mock) · `pnpm test:browser` (real Chromium vs local fake Instagram)
- Typecheck: `pnpm typecheck` · Format: `pnpm format`
- Build: `pnpm build` (console)

## Working conventions
Follow existing patterns and applicable framework/version documentation. Keep changes small; reuse dependencies. Run relevant checks and report results. Never commit secrets or perform destructive/external operations without authorization. Never claim real-Instagram behavior is verified unless tested with an authorized account (see `docs/LIMITATIONS.md`).

Keep these instructions stable and compact. The changing implementation state belongs in `docs/AI_HANDOFF.md`; read it once at fresh-session start when relevant. Suggest save-context after milestones. Do not duplicate it here or in README.
