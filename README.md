# Hepson Instagram Connector

Local-first connector exposing Instagram Direct conversations of **shop-owned, owner-authorized** accounts through a stable, authenticated HTTP API (`/v1`, REST + SSE). The first provider is an **experimental browser (Playwright) adapter**; a mock provider runs the identical contract and UI with no Instagram access. A future Meta official-API adapter plugs into the same interface ([docs/FUTURE_META_ADAPTER.md](docs/FUTURE_META_ADAPTER.md)).

> **Status:** mock mode, persistence/lifecycle, parsing, dedupe and send semantics are tested (see [Test results](#test-results)). **Nothing has been verified against real instagram.com**; selectors are uncalibrated. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) and [docs/MANUAL_INSTAGRAM_TEST.md](docs/MANUAL_INSTAGRAM_TEST.md).

## Install (clean checkout)

```bash
corepack enable            # or: npm i -g pnpm
pnpm install               # if better-sqlite3 has no binding: pnpm rebuild better-sqlite3
pnpm exec playwright install chromium   # only needed for real/browser mode and pnpm test:browser
cp .env.example .env       # optional; defaults are fine (data dir: ~/.hepson)
pnpm migrate               # creates the SQLite DB
pnpm bootstrap-key         # prints an ADMIN API key ONCE (only its SHA-256 is stored)
```

## Run in mock mode (no Instagram, no paid services)

```bash
pnpm start:api             # http://127.0.0.1:8787  (terminal 1)
pnpm dev:console           # http://127.0.0.1:5173  (terminal 2)
```

Open the console, paste the API key, **New account → Mock → Create → Start**. You get 3 realistic Ukrainian shop chats. Select a chat, tick `outboundEnabled`, send a reply, watch outbox + live SSE events. "simulate incoming" injects a customer message. Everything mock is labelled **MOCK**.

## Run with a real Instagram account (experimental, operator-assisted)

1. Get the shop owner's **express authorization** (the console requires the consent checkbox).
2. Console → New account → *Real Instagram* (optionally the expected handle) → **Start / initial login**. A **visible** Chromium window opens on this machine; **the owner types credentials/2FA there**. Hepson never sees them.
3. Once the inbox is reachable and the signed-in handle is confirmed, status becomes `connected`. The login is stored only in `~/.hepson/profiles/<accountUUID>/` (mode 0700).
4. Restart Hepson/the machine: enabled accounts reopen the **same profile** automatically — no login unless Instagram invalidated it (`login_required`).

Run `pnpm calibrate <accountUUID>` first and follow [docs/MANUAL_INSTAGRAM_TEST.md](docs/MANUAL_INSTAGRAM_TEST.md).

## Commands

| Command | Purpose |
|---|---|
| `pnpm migrate` | apply DB migrations |
| `pnpm bootstrap-key [name] [--account <uuid>]` | create admin / account-scoped key (shown once) |
| `pnpm start:api` / `dev:api` | run API (127.0.0.1:8787) |
| `pnpm dev:console` / `build` | dev console / production build |
| `pnpm test` | 38 unit+integration tests (mock) |
| `pnpm test:browser` | 20 real-Chromium tests against a **local fake Instagram** |
| `pnpm typecheck`, `pnpm format` | tsc strict / prettier |
| `pnpm openapi` | write `docs/openapi.json` (also served at `/v1/openapi.json`) |
| `pnpm calibrate <id> [--snapshot]` | live selector check (real, authorized account) |
| `pnpm smoke:live` | opt-in guided live smoke (never in CI) |
| `pnpm example` | [example-client.ts](example-client.ts): subscribe + human-approved reply |

## Environment variables

See [.env.example](.env.example). Key ones: `HEPSON_DATA_DIR` (DB, profiles, locks; keep outside the repo, on an encrypted disk, out of cloud backup), `HEPSON_HOST` (default `127.0.0.1` — do not expose publicly), `HEPSON_POLL_INTERVAL_MS` (20 s), `HEPSON_RETENTION_DAYS` (30), `HEPSON_BACKFILL_EVENTS` (false), `HEPSON_BROWSER_HEADLESS` (tests only; owner login needs headed), `HEPSON_AUTOSTART`.

## Troubleshooting

- `Could not locate the bindings file` → `pnpm rebuild better-sqlite3`.
- `Executable doesn't exist … chromium` → `pnpm exec playwright install chromium`.
- Status `login_required` → owner re-logs in via **Start / initial login**; the profile is *not* deleted.
- Status `checkpoint_required` → owner completes Instagram's check in the visible window. Hepson never bypasses it.
- `PROFILE_LOCKED` → another Hepson process owns the profile. If you are sure it is gone, delete `~/.hepson/locks/<uuid>.lock` (never the profile).
- `IDENTITY_MISMATCH` → the profile is signed in as a different handle than the store expects; review, then Forget saved login and redo login.
- `UI_CHANGED` → Instagram's markup differs from `selectors.ts`; run `pnpm calibrate`.
- No window appears on a headless server → real mode needs a display (headed Chromium).

## Docs

[API](docs/API.md) · [Manual Instagram test](docs/MANUAL_INSTAGRAM_TEST.md) · [Limitations](docs/LIMITATIONS.md) · [Future Meta adapter](docs/FUTURE_META_ADAPTER.md) · [Plan](docs/PLAN.md) · [Checklist](docs/CHECKLIST.md)

## Test results

See [docs/CHECKLIST.md](docs/CHECKLIST.md) for what each suite proves and what still needs a live smoke test.
