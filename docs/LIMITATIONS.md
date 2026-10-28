# Limitations & risks

## Verified vs. not
- Verified (automated): contract, tenant isolation, dedupe, idempotency, outbox states, event replay, and — in **real headless Chromium against a local fake Instagram** — profile reuse across restarts, login_required/checkpoint/identity-mismatch fail-closed, pause/forget semantics, lock handling, text/media parsing, send confirmation/uncertain.
- **Not verified:** anything on real instagram.com. `selectors.ts` is `CALIBRATION_STATUS = 'uncalibrated'`. The fake is our own assumption of the DOM, so passing it does not imply the real UI matches. Headed mode differs from the headless flag only by display.

## Instagram surfaces
Supported (once calibrated): primary inbox, 1:1 text messages, visible DOM history only (no scrolling/older paging), image/video/audio as **placeholders** (no media download, no text invented). Unsupported: General and Requests folders (capability reported `false`), group chats not specifically handled, reactions, replies/quotes, shared posts/stories content, voice transcription, message deletion/unsend, read receipts, bulk/outreach (intentionally absent).
Timestamps are only trusted when exposed as ISO `datetime`; otherwise `null`. Unread flags may be `null`.

## Login & sessions
- Owner must log in personally, in a visible window on the machine running Hepson (operator-assisted). Reauthentication is required when Instagram expires/revokes/challenges the session. Longevity is **not guaranteed**.
- Cookies live only in the Chromium profile (`$HEPSON_DATA_DIR/profiles/<uuid>`, 0700). Chromium flushes cookies periodically and on graceful close; a hard kill within ~a minute of login can lose the session.
- Challenges/2FA/CAPTCHA are never automated or bypassed: worker stops, owner acts.
- Remote self-service onboarding (owner logging in from their own computer) is **not implemented**; it needs a secure remote-browser deployment and consent flow (future phase).
- Persistent workers need a durable local filesystem. Do not run browser workers on ephemeral/serverless filesystems; API/UI may be hosted separately.

## Detection of new messages
Polling (default 20 s) of the visible inbox; the inbox is reloaded at most every 5 min. Provider message IDs are not assumed; fingerprints = account+thread+direction+sender+normalized text+ISO time (or null)+occurrence index. Known limit: identical texts with unknown timestamps can be conflated if the visible window slides past earlier duplicates. Messages deleted/edited on Instagram are not reflected.

## Policy & privacy
Automating Instagram's web UI may breach Instagram's Terms and can lead to challenges, rate limits or account restrictions. Use only on accounts whose owners consented in writing and understand this. The compliant long-term path is the official Meta API (docs/FUTURE_META_ADAPTER.md). Messages of customers are personal data (GDPR/Ukrainian law): retention default 30 days, export and delete endpoints provided, logs never contain message text, API keys or cookies. Profile directories are credentials-equivalent: use disk encryption, exclude from backups, never serve or commit them.
