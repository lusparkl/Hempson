# Hepson

Ukrainian-first, multi-shop AI sales assistant for online shops. Customers write over Instagram (official Meta API) or a website chat widget. An OpenAI agent answers from verified catalog data and prepares order drafts. Shop members watch chats, take over and approve orders in a dashboard.

> **Status (2026-10-31):** F1-F12 and P1 are built and tested against mocks (see [docs/ROADMAP.md](docs/ROADMAP.md)). Official Instagram works live on one tester account through **polling**; Meta has not delivered real message webhooks yet (D30, [docs/LIMITATIONS.md](docs/LIMITATIONS.md)). P2-P9 (Telegram, policies, Nova Poshta, payments, ...) are not built. The Phase 1 browser connector is frozen and off by default (D22).

Start here: [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) (product and rules) · [docs/OVERVIEW.md](docs/OVERVIEW.md) (code map) · [docs/ROADMAP.md](docs/ROADMAP.md) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/AI_HANDOFF.md](docs/AI_HANDOFF.md) (current state).

## Install

```bash
corepack enable            # or: npm i -g pnpm
pnpm install               # if better-sqlite3 has no binding: pnpm rebuild better-sqlite3
pnpm exec playwright install chromium   # only for pnpm test:browser and the frozen browser adapter
pnpm migrate               # creates the SQLite DB (~/.hepson/hepson.db)
pnpm bootstrap-key         # prints an ADMIN API key once (only for /v1/accounts and the dev console)
```

## Run

Nothing auto-loads `.env`. Pass it explicitly, plus any private env files:

```bash
pnpm exec tsx --env-file=.env apps/api/src/index.ts   # API on http://127.0.0.1:8787
pnpm dev:dashboard                                    # owner dashboard on http://127.0.0.1:5174
pnpm dev:console                                      # admin dev console (Phase 1 accounts), port 5173
```

Without any env, the API runs with shops, catalog, conversations, website chat and the dashboard. Optional parts switch on when their variables are set:

| Part | Needs |
|---|---|
| AI agent | `OPENAI_API_KEY`, `HEPSON_OPENAI_MODEL`; then each owner enables AI per shop |
| Telegram operator notifications | `HEPSON_TELEGRAM_BOT_TOKEN`; each owner sets a chat id |
| Encrypted per-shop credentials | `HEPSON_MASTER_KEY` (`pnpm gen-master-key`; keep outside the repo and backups) |
| Official Instagram | master key + `HEPSON_META_APP_ID`, `HEPSON_META_APP_SECRET`, `HEPSON_META_CONFIG_ID`, `HEPSON_META_VERIFY_TOKEN`, a public HTTPS `HEPSON_PUBLIC_URL`; `HEPSON_INSTAGRAM_POLL_SECONDS` for polling intake |

All variables and defaults: [.env.example](.env.example). Meta setup: webhook callback `<HEPSON_PUBLIC_URL>/webhooks/instagram`, OAuth redirect `<HEPSON_PUBLIC_URL>/public/instagram/callback` (D29).

## Commands

| Command | Purpose |
|---|---|
| `pnpm migrate` | apply DB migrations (new: `pnpm exec drizzle-kit generate`) |
| `pnpm start:api` / `dev:api` | run API without env files (watch mode for `dev:`) |
| `pnpm dev:dashboard` / `dev:console` | front ends |
| `pnpm build` | build dev console and dashboard |
| `pnpm test` | unit + integration tests (mocks; 346 tests, 27 files on 2026-10-31) |
| `pnpm test:browser` | real Chromium vs local fake Instagram and widget tests |
| `pnpm typecheck` | tsc strict |
| `pnpm openapi` | write `docs/openapi.json` (also served at `/v1/openapi.json`) |
| `pnpm backup [dest]` | online SQLite backup (never copies browser profiles) |
| `pnpm gen-master-key` / `rewrap-credentials` | create or rotate the credential master key (D28) |
| `pnpm bootstrap-key [name] [--account <uuid>]` | admin or account-scoped Phase 1 API key |
| `pnpm calibrate`, `pnpm smoke:live` | frozen browser adapter only ([docs/MANUAL_INSTAGRAM_TEST.md](docs/MANUAL_INSTAGRAM_TEST.md)) |

`pnpm format` is not clean repo-wide; format only the files you change.

## Troubleshooting

- `Could not locate the bindings file` → `pnpm rebuild better-sqlite3`.
- `Executable doesn't exist … chromium` → `pnpm exec playwright install chromium`.
- Instagram connect or webhooks disabled → one of the Meta variables or `HEPSON_MASTER_KEY` is missing.
- No Instagram messages arrive → set `HEPSON_INSTAGRAM_POLL_SECONDS` (webhooks are not delivered yet, D30).
- Tunnel URL changed → update `HEPSON_PUBLIC_URL`, the Meta webhook callback and OAuth redirect, then reconnect Instagram in the dashboard.

## Docs

[API](docs/API.md) · [Limitations](docs/LIMITATIONS.md) · [Roadmap](docs/ROADMAP.md) · [Decisions](docs/DECISIONS.md) · [Project context](docs/PROJECT_CONTEXT.md) · [Overview](docs/OVERVIEW.md) · [Manual browser-adapter test (frozen)](docs/MANUAL_INSTAGRAM_TEST.md)
