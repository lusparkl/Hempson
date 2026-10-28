# Project instructions

## Architecture
- Purpose: Hepson Instagram Direct connector — provider-agnostic, authenticated local HTTP API (REST + SSE) for reading/sending DMs of shop-owned, owner-authorized Instagram accounts. Phase-2 AI sales manager consumes this API; it is out of scope here.
- Runtime: Node >=22 (dev on 24), TypeScript strict, pnpm workspace, Fastify 5, Zod 4, SQLite via better-sqlite3 + Drizzle, Playwright (persistent headed Chromium), Vitest, React/Vite dev console.
- Boundaries: `packages/connector-core` (types, errors, events, fingerprint) · `packages/database` (schema, migrations, `Store`) · `packages/mock-adapter` · `packages/instagram-browser` (ALL Instagram DOM knowledge in `selectors.ts`/`parsers.ts`; profile/lock/login/sender) · `apps/api` (routes, `ConnectorService` worker/send queue, event bus) · `apps/dev-console`.
- Invariants: one persistent profile dir per account (`$HEPSON_DATA_DIR/profiles/<uuid>`, never deleted except explicit forget); no credential/cookie handling by Hepson; adapters throw only before an irreversible UI action, otherwise return `uncertain` (never auto-retried); every query is accountId-scoped.

## Development commands
- Install: `pnpm install` then `pnpm rebuild better-sqlite3` if the native binding is missing; `pnpm exec playwright install chromium`
- Migrate: `pnpm migrate` (generate new: `pnpm exec drizzle-kit generate`)
- Develop: `pnpm bootstrap-key` once, `pnpm start:api` (or `dev:api`), `pnpm dev:console`
- Test: `pnpm test` (unit+integration, mock) · `pnpm test:browser` (real Chromium vs local fake Instagram)
- Typecheck: `pnpm typecheck` · Format: `pnpm format`
- Build: `pnpm build` (console)

## Working conventions
Follow existing patterns and applicable framework/version documentation. Keep changes small; reuse dependencies. Run relevant checks and report results. Never commit secrets or perform destructive/external operations without authorization. Never claim real-Instagram behavior is verified unless tested with an authorized account (see `docs/LIMITATIONS.md`).

Keep these instructions stable and compact. The changing implementation state belongs in `docs/AI_HANDOFF.md`; read it once at fresh-session start when relevant. Suggest save-context after milestones. Do not duplicate it here or in README.
