# AI Handoff

Updated: 2026-10-28T20:15Z
Base commit: 73364e1 (live-calibration work is in the next commit; check `git log`)
Branch: main
Working tree: see `git status`; this file is excluded from the check.

## Purpose and architecture
Hepson Instagram connector: authenticated local HTTP API (REST + SSE) over Instagram Direct for owner-authorized accounts. Layout and invariants are in `AGENTS.md`. All Instagram DOM knowledge is in `packages/instagram-browser/src/selectors.ts` and `parsers.ts`; the service in `apps/api/src/services/connector-service.ts` polls, dedupes by fingerprint and emits events.

## Implemented state
Phase 1 is functionally complete and was verified live on 2026-10-28 (one account, English UI): login once, calibration, read, inbound exactly once, one outbound send, restart persistence (graceful and `kill -9`), pause/resume with a mock second store, scoped-key isolation, `login_required` after logout. Results: `docs/MANUAL_INSTAGRAM_TEST.md`; per-feature status: `docs/CHECKLIST.md`.

Real-UI facts that shaped the code: thread list rows are `div[role=button]` with no href (thread id learned by selecting the row, cached by title+preview; this marks chats read); messages are `role=group` > `role=article`, sender from the "React to message from <handle>" label; composer is an unnamed Lexical contenteditable, "Send" button exists only with text; all times are relative/localized so timestamps are `null` and change detection uses preview + relative label; history loads lazily (older-than-known messages are stored, not announced).

## Decisions and environment
Node 24, pnpm. Data dir `~/.hepson` (`HEPSON_DATA_DIR`). Never use `pkill -f` with a pattern that appears in your own command line. Do not put named inner functions inside `page.evaluate*` callbacks: `tsx` injects `__name`, which breaks in the page (vitest does not reproduce it, only a live/tsx run does).

## Validation
2026-10-28: `pnpm typecheck` clean; `pnpm test` 38 pass; `pnpm test:browser` 21 pass (fake Instagram mirrors the observed DOM, so it does not prove the real UI); `pnpm calibrate` passes on the live account.

## Known issues and uncertainties
Untested live: media placeholders, group chats, non-English locales, a second real account, the `uncertain` send path, concurrent sends, "Forget saved login", checkpoint re-trigger, full machine reboot. Repeated identical customer text inside one relative-time bucket may not trigger a re-read until the label changes. Multi-line replies are untested. Automating the web UI may breach Instagram's terms; the compliant path is the Meta API (`docs/FUTURE_META_ADAPTER.md`).

## Next actions
1. Run the untested items above on a real second account; update `docs/CHECKLIST.md`.
2. Re-run `pnpm calibrate <id>` whenever `UI_CHANGED` appears; fix only `selectors.ts`/`parsers.ts`.
3. Decide on General/Requests folders, older-history paging and group chats (currently unsupported).
4. Phase 2 (AI sales manager) consumes `/v1` and is out of scope here.
