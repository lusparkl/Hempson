# Manual live test (real Instagram) — NOT YET PERFORMED

Everything here must be run by a human with a **shop-owned account** and the owner's **express authorization**, plus a **second authorized test account** to send DMs. Nothing in this repo has been run against real instagram.com. Record each step as `pass`, `fail`, `blocked` or `not tested`.

## 0. Prerequisites
Display available (headed Chromium), `pnpm install`, `pnpm exec playwright install chromium`, `pnpm migrate`, admin key, API running. Prefer a throw-away/test shop account first. Disk encryption on. Expect Instagram may challenge a new browser: the owner completes it manually; never work around it.

## 1. Connect A (login once)
Console → New account → *Real Instagram* + consent + expected handle → **Start / initial login**. The owner signs in in the visible window (incl. 2FA). Expect status `connected` and handle confirmed. If it stays `login_required`/`failed(UI_CHANGED)`: run step 2.

## 2. Calibrate selectors (expected to be needed)
Stop the API (profile lock!), then `pnpm calibrate <accountUUID>`. Every `false`/`0` (and `composerMatches != 1`) must be fixed in `packages/instagram-browser/src/selectors.ts` using Playwright role/label locators; re-run. `--snapshot` writes an ARIA snapshot containing **private chat text** — keep it local, never commit/share. Update `CALIBRATION_STATUS` only after a successful pass.

## 3. Read
Open A's conversations in the console; compare titles/order with the real inbox. Open one chat: direction (incoming vs outgoing) and text must match. Timestamps may legitimately be `null`.

## 4. Inbound exactly once
From the second account DM the shop. Expect one `message.received` (console Events or `pnpm example`). Wait 3 poll cycles: still one.

## 5. Outbound
Tick `outboundEnabled`. Send one reply from the console (confirmation dialog). Verify in the real Instagram chat: once, outgoing. Outbox must end `sent`; if `uncertain`, check Instagram, then **Mark reviewed**. `pnpm smoke:live` guides steps 3–5 (`HEPSON_LIVE_SMOKE=I_HAVE_OWNER_AUTHORIZATION`).

## 6. Restart persistence (the critical one)
1. Ctrl-C the API (graceful: Chromium closes and flushes cookies). Confirm no Chromium for the account remains.
2. `pnpm start:api` again. Without touching anything, account A should reach `connected` with the banner "Previous login restored automatically". **No login window credentials.** No `message.received` for old history.
3. Repeat after a full machine reboot, and once after `kill -9` of the API process (hard-kill >60 s after login so Chromium has flushed cookies; if login is lost here, note it — it is a Chromium flush limit, not a Hepson delete).
Pass = reconnect with no login prompt while Instagram still honors the session.

## 7. Isolation & lifecycle
Add store B (second authorized account, or a mock). Pause A: B stays `connected`; `~/.hepson/profiles/<A>` and `<B>` both still exist. Resume A: reconnects without login. Then **Forget saved login** on A (type its label): profile directory gone, A → `login_required`, B untouched.

## 8. Failure surfaces
Log out of Instagram in A's window → `login_required` within one reload interval (≤5 min or next send). Trigger/observe a checkpoint → `checkpoint_required`, worker stopped.

## Fragility notes
Instagram changes markup and localization without notice; selectors may break any time (`UI_CHANGED`). Locale affects accessible names (`Profile`/`Профіль` handled; others are not). Automated access may violate Instagram's terms and may trigger challenges or restrictions — see LIMITATIONS.md.

## Results log (fill in)
| Step | Result | Date / notes |
|---|---|---|
| 1 login once | not tested | |
| 2 calibration | not tested | |
| 3 read | not tested | |
| 4 inbound once | not tested | |
| 5 outbound once | not tested | |
| 6 restart persistence | not tested | |
| 7 isolation / forget | not tested | |
| 8 logout / checkpoint | not tested | |
