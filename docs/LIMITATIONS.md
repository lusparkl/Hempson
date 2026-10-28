# Limitations & risks

## Verified vs. not
- Verified (automated): contract, tenant isolation, dedupe, idempotency, outbox states, event replay, and — in real headless Chromium against a local fake Instagram (now mirroring the observed real DOM) — profile reuse, fail-closed states, pause/forget semantics, lock handling, parsing, send confirmation/uncertain.
- Verified live (2026-10-28, one authorized account, English UI, primary inbox): login once, selector calibration (`CALIBRATION_STATUS = 'calibrated-en-2026-10'`), reading 1:1 text chats with correct direction and emoji, inbound exactly once, one outbound send confirmed `sent` without duplicates, pause/resume with a second (mock) store, scoped-key isolation, restart persistence (graceful and `kill -9`), `login_required` after logout.
- **Not verified live:** media placeholders, group chats, non-English UI, a second real account, the `uncertain` send path, concurrent sends, checkpoint re-trigger, "Forget saved login", identity-mismatch with a real wrong account. Instagram can change markup at any time; re-run `pnpm calibrate`.

## Real-UI behaviours that shape the design
- The thread list has no hrefs. Thread ids are learned by selecting each row and reading `/direct/t/<id>/`, cached by title+preview. **Selecting a chat marks it read for the owner.**
- Sender comes from the "React to message from <handle>" label; direction = sender equals the signed-in handle.
- Message and list times are localized/relative text, never ISO, so `sentAt`/`latestMessageAt` are `null`. Change detection uses row preview + relative-time label.
- History loads lazily. Messages revealed later that sit before an already-known one are stored but not announced as `message.received`.
- Known gap: the same text sent twice by a customer inside one relative-time bucket (e.g. both "now") may not trigger a re-read until the label changes.
- The reply text is typed into a Lexical editor; multi-line text is untested and fails closed (`UI_CHANGED`) if the editor does not read back identically.

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
