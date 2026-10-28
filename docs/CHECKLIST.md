# Feature checklist

Legend: ✅ implemented + automated test · 🧪 implemented, tested only against the local FAKE Instagram · ⛔ needs real Instagram smoke test · ➖ not implemented

| Feature | Mock | Browser (fake) | Real Instagram |
|---|---|---|---|
| Account CRUD, consent gate, scoped API keys | ✅ | ✅ | n/a |
| Tenant isolation (keys, ids, events, outbox) | ✅ | ✅ | n/a |
| Persistent per-account profile, reused on restart | n/a | ✅ real Chromium | ✅ (graceful restart + kill -9) |
| Auto-reconnect at boot without login | n/a | ✅ | ✅ |
| login_required on revoked/expired session, profile kept | ✅ | ✅ | ✅ (manual logout) |
| Checkpoint → checkpoint_required, worker stopped | ✅ | ✅ | ✅ (seen at first login; not re-triggerable) |
| Wrong-account profile fails closed | n/a | ✅ | ⛔ (only one real account) |
| Profile dir 0700, lock file, stale-lock handling | n/a | ✅ | ✅ (OS-level) |
| Pause / disconnect keep profile; forget deletes only that profile (confirm) | ✅ | ✅ | ✅ pause/resume · ⛔ forget (skipped on purpose) |
| Browser crash → degraded → auto-reopen same profile | n/a | ✅ | ⛔ |
| List conversations / read text / direction / null timestamps | ✅ | 🧪 | ✅ text+emoji · ⛔ media placeholders |
| New inbound exactly once, no replay after restart | ✅ | 🧪 | ✅ |
| Send: serialized queue, idempotency, outboundEnabled | ✅ | 🧪 | ✅ single send · ⛔ concurrent sends |
| Send: UI verification, `uncertain`, never auto-retry, review, later auto-resolve | ✅ | 🧪 | ✅ verified `sent` · ⛔ `uncertain` path |
| UI_CHANGED on missing composer / title mismatch / unknown direction | ✅ | 🧪 | ⛔ (not provoked live) |
| SSE ordering + replay, persisted-before-emit | ✅ | ✅ | n/a |
| Export / delete / retention (30 d) | ✅ | ✅ | n/a |
| Log redaction (auth header, cookies, message text) | ✅ | ✅ | n/a |
| OpenAPI, curl examples, example client | ✅ | n/a | n/a |
| Dev console (mock + real labels, forget/reconnect, outbox review, SSE) | ✅ build | manual | ⛔ (live run used the API directly) |
| General / Requests folders, older-history paging, group chats | ➖ | ➖ | ➖ |
| Remote owner onboarding | ➖ | ➖ | ➖ |
| Meta official adapter | ➖ (documented) | | |
