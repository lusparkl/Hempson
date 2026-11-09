# Hepson

Ukrainian-first, multi-shop AI sales assistant for online shops. Customers write over Instagram (official Meta API), the shop's Telegram bot or a website chat widget. An OpenAI agent answers from verified catalog data and prepares order drafts. Shop members watch chats, take over and approve orders in a dashboard.

> **Status (2026-11-06):** F1-F12 and P1-P10 are built (see [docs/ROADMAP.md](docs/ROADMAP.md)); Nova Poshta and Monobank are tested only against local fakes. Official Instagram works live on one tester account through **polling**; Meta has not delivered real message webhooks yet (D30, [docs/LIMITATIONS.md](docs/LIMITATIONS.md)). The old browser connector was removed (D41).

Start here: [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) (product and rules) · [docs/OVERVIEW.md](docs/OVERVIEW.md) (code map) · [docs/ROADMAP.md](docs/ROADMAP.md) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/AI_HANDOFF.md](docs/AI_HANDOFF.md) (current state).

## Install

```bash
corepack enable            # or: npm i -g pnpm
pnpm install               # if better-sqlite3 has no binding: pnpm rebuild better-sqlite3
pnpm exec playwright install chromium   # only for pnpm test:browser
pnpm migrate               # creates the SQLite DB (~/.hepson/hepson.db)
pnpm bootstrap-key         # optional: prints an operator API key once (only for setting a shop's plan by hand)
```

## Run

Nothing auto-loads `.env`. Pass it explicitly, plus any private env files:

```bash
pnpm exec tsx --env-file=.env apps/api/src/index.ts   # API on http://127.0.0.1:8787
pnpm dev:dashboard                                    # owner dashboard on http://127.0.0.1:5174
pnpm dev:website                                      # marketing site on http://127.0.0.1:5175
```

Without any env, the API runs with shops, catalog, conversations, website chat and the dashboard. Optional parts switch on when their variables are set:

| Part | Needs |
|---|---|
| AI agent | `OPENAI_API_KEY`, `HEPSON_OPENAI_MODEL`; then each owner enables AI per shop |
| Telegram operator notifications | `HEPSON_TELEGRAM_BOT_TOKEN`; each owner sets a chat id |
| Outage alerts to the operator | `HEPSON_ALERT_TELEGRAM_CHAT_ID`; run `pnpm watchdog` on another machine (D49) |
| Encrypted per-shop credentials | `HEPSON_MASTER_KEY` (`pnpm gen-master-key`; keep outside the repo and backups) |
| Shop channels and integrations (Telegram bot, Nova Poshta, Monobank) | master key; each owner connects their own account |
| Official Instagram | master key + `HEPSON_META_APP_ID`, `HEPSON_META_APP_SECRET`, `HEPSON_META_CONFIG_ID`, `HEPSON_META_VERIFY_TOKEN`, a public HTTPS `HEPSON_PUBLIC_URL`; `HEPSON_INSTAGRAM_POLL_SECONDS` for polling intake |

All variables and defaults: [.env.example](.env.example). Meta setup: webhook callback `<HEPSON_PUBLIC_URL>/webhooks/instagram`, OAuth redirect `<HEPSON_PUBLIC_URL>/public/instagram/callback` (D29).

## Commands

| Command | Purpose |
|---|---|
| `pnpm migrate` | apply DB migrations (new: `pnpm exec drizzle-kit generate`) |
| `pnpm start:api` / `dev:api` | run API without env files (watch mode for `dev:`) |
| `pnpm dev:dashboard` / `dev:website` | front ends |
| `pnpm build` / `build:website` | build the dashboard / prerender the marketing site |
| `pnpm test` | unit + integration tests (fakes only; 438 tests, 35 files on 2026-11-06) |
| `pnpm test:browser` | website chat widget in real Chromium |
| `pnpm typecheck` | tsc strict |
| `pnpm openapi` | write `docs/openapi.json` (also served at `/v1/openapi.json`) |
| `pnpm backup [dest]` | online SQLite backup |
| `pnpm gen-master-key` / `rewrap-credentials` | create or rotate the credential master key (D28) |
| `pnpm bootstrap-key [name]` | operator API key for `PUT /v1/shops/:shopId/plan` (D41) |

`pnpm format` is not clean repo-wide; format only the files you change.

## Troubleshooting

- `Could not locate the bindings file` → `pnpm rebuild better-sqlite3`.
- `Executable doesn't exist … chromium` → `pnpm exec playwright install chromium`.
- Instagram connect or webhooks disabled → one of the Meta variables or `HEPSON_MASTER_KEY` is missing.
- No Instagram messages arrive → set `HEPSON_INSTAGRAM_POLL_SECONDS` (webhooks are not delivered yet, D30).
- Tunnel URL changed → update `HEPSON_PUBLIC_URL`, the Meta webhook callback and OAuth redirect, then reconnect Instagram in the dashboard.

## Docs

[API](docs/API.md) · [Limitations](docs/LIMITATIONS.md) · [Roadmap](docs/ROADMAP.md) · [Decisions](docs/DECISIONS.md) · [Project context](docs/PROJECT_CONTEXT.md) · [Overview](docs/OVERVIEW.md) · [Inventory](docs/INVENTORY.md)
