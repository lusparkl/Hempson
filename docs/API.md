# Hepson HTTP API v1

Base: `http://127.0.0.1:8787` (loopback by default). OpenAPI with every route and schema: `GET /v1/openapi.json` or `pnpm openapi` → `docs/openapi.json`.

## Shop API (Phase 2 and P1)
Dashboard users authenticate with `Authorization: Bearer hsu_…` from `POST /v1/auth/login` (or `/register`). These routes reject `hep_` API keys. Every `/v1/shops/:shopId/...` route checks membership; a shop the user is not a member of is `404`, an owner-only write by a manager is `403`.
```
GET    /health · /ready
POST   /v1/auth/register|login|logout   GET /v1/auth/me
GET|POST /v1/shops   GET|PATCH /v1/shops/:shopId   members: GET|POST .../members, PATCH|DELETE .../members/:userId
catalog: .../products[/:productId[/variants[/:variantId[/stock]]]], POST .../products/import {csv, dryRun}
chats:   GET .../customers, GET .../conversations[/:id], GET|POST .../conversations/:id/messages, PUT .../conversations/:id/ai {paused}
agent:   GET|PUT .../ai, GET .../ai/runs, GET .../escalations, POST .../escalations/:id/resolve
orders:  GET .../order-drafts[/:draftId], POST .../order-drafts/:draftId/approve|reject
other:   GET .../channels, GET|PUT .../notifications, GET .../stats?from&to, GET|PUT .../web-chat, POST .../web-chat/rotate-key
instagram (official, D29): GET|DELETE .../instagram, POST .../instagram/connect
public:  POST /public/web-chat/:widgetKey/session, POST|GET /public/web-chat/:widgetKey/messages, GET /widget/web-chat.js
         GET /public/instagram/callback (OAuth), GET|POST /webhooks/instagram (handshake, signed events; not in OpenAPI)
```

# Phase 1 connector API (frozen, D22)

The `/v1/accounts` API below serves the mock and the frozen browser adapter. Creating or connecting an `instagram-browser` account is refused unless `HEPSON_ENABLE_BROWSER_ADAPTER=true`.

## Authentication (connector)
`Authorization: Bearer hep_…` on everything except `GET /health`, `GET /v1/openapi.json`.
- **Admin key** (`pnpm bootstrap-key`): any account, may create accounts and keys.
- **Account key** (`pnpm bootstrap-key --account <uuid>` or `POST /v1/accounts/:id/api-keys`): valid only for that account. Other accounts → `403 FORBIDDEN`; foreign conversation/outbox ids → `404`. `accountId` is only ever taken from the URL path, never the body.
Keys are shown once; only SHA-256 hashes are stored.

## Errors
Always `{ "error": { "code", "message", "retryable" } }`.

| code | HTTP | meaning |
|---|---|---|
| `LOGIN_REQUIRED` | 409 | Instagram session invalid; owner must log in (visible window) |
| `CHECKPOINT_REQUIRED` | 409 | Instagram security check; owner must complete manually |
| `UI_CHANGED` | 502 | page did not match `selectors.ts`; operation aborted (never guessed) |
| `UNSUPPORTED_CONTENT` | 422 | content type not readable |
| `TEMPORARY_FAILURE` | 503 | transient, `retryable:true` |
| `RATE_LIMITED_OR_BLOCKED` | 429 | Instagram throttled/blocked; worker stopped |
| `UNAUTHORIZED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 · `VALIDATION_ERROR` 400 | | |
| `OUTBOUND_DISABLED` | 403 | `outboundEnabled=false` |
| `CONSENT_REQUIRED` | 400 | real account without owner consent |
| `IDEMPOTENCY_CONFLICT` | 409 | key reused with different conversation/text |
| `ACCOUNT_NOT_CONNECTED` · `IDENTITY_MISMATCH` · `PROFILE_LOCKED` | 409 | |
| `CONFIRMATION_REQUIRED` | 400 | destructive action needs `confirmLabel` = account label |

## Routes
```
GET    /health
GET    /v1/accounts                                   (scoped key sees only its account)
POST   /v1/accounts                                   admin  { label, connectorType: "mock"|"instagram-browser", consentConfirmed, expectedInstagramHandle? }
GET    /v1/accounts/:id/status
POST   /v1/accounts/:id/session/start                 { interactive?: true }  → 202; opens visible window if login needed
POST   /v1/accounts/:id/session/pause|resume|disconnect   (profile kept)
DELETE /v1/accounts/:id/session/profile               { confirmLabel }  FORGETS saved login (deletes profile)
PATCH  /v1/accounts/:id/settings                      { outboundEnabled }
GET    /v1/accounts/:id/conversations?limit&cursor
GET    /v1/accounts/:id/conversations/:cid/messages?limit&cursor
POST   /v1/accounts/:id/conversations/:cid/messages   { text, idempotencyKey, dryRun? } → 202 { outboxId, status }
GET    /v1/accounts/:id/outbox  ·  /outbox/:oid  ·  POST /outbox/:oid/review
GET    /v1/accounts/:id/events?afterSequence&limit    replay
GET    /v1/accounts/:id/events/stream                 SSE
GET    /v1/accounts/:id/export  ·  DELETE /data {confirmLabel}  ·  POST /retention/purge
POST   /v1/accounts/:id/api-keys                      admin { name }
# dev/mock only (HEPSON_ENABLE_DEV_ROUTES): /v1/dev/accounts/:id/{inject-incoming,set-status,plan-sends,sync}
```
Status values: `disconnected | login_required | connecting | connected | degraded | checkpoint_required | failed`. The status view also reports `restoredFromSavedLogin`, `hasSavedLogin`, `awaitingOwnerAction`, `dataSource` (MOCK/REAL).

## Pagination
Conversations: newest first, opaque `cursor`. Messages: each page is oldest→newest; `nextCursor` fetches **older** pages (`null` = end of the cache). Pages reflect Hepson's cache of what the UI exposed, not guaranteed complete history.

## Events & replay
`{ id (uuid), accountId, sequence, type, occurredAt, payload }`. `sequence` is gapless and monotonic **per account** starting at 1. Events are written to SQLite **before** being published. Types: `message.received`, `message.sent`, `conversation.updated`, `session.connected`, `session.login_required`, `session.checkpoint_required`, `connector.degraded`, `connector.error`.
SSE: `GET …/events/stream?afterSequence=N` (or `Last-Event-ID`) first replays persisted events > N, then streams live ones with `id: <sequence>`; no gaps, no duplicates. Use `fetch` streaming (EventSource cannot send the Authorization header). A pre-existing history is *not* emitted as `message.received` on first sync (`HEPSON_BACKFILL_EVENTS=true` to change).

## Sending & idempotency
- One text per request, to an existing conversation. No bulk endpoint exists.
- `idempotencyKey` (8–128 chars) is unique per account. Same key + same body → returns the original outbox (`Idempotent-Replay: true`), **no second send**. Same key + different body → 409. Same text with a new key → sent again (intentional).
- Outbox: `queued → sending → sent | failed | uncertain`. `uncertain` = the send click may have happened but the message was not confirmed in the UI. It is **never retried automatically**; `needsReview=true` until a human checks Instagram and calls `/review`. If a later sync observes the message, the entry resolves to `sent` without a duplicate.
- Process crash while `sending` → recorded as `uncertain` on next start; `queued` → `failed`.
- `dryRun:true` validates (auth, consent/outbound, text, conversation, connection) and returns `200 {dryRun:true}` without sending.

```bash
KEY=hep_…; A=<account uuid>; BASE=http://127.0.0.1:8787
curl -s $BASE/v1/accounts/$A/status -H "authorization: Bearer $KEY"
curl -s -XPATCH $BASE/v1/accounts/$A/settings -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"outboundEnabled":true}'
curl -s -XPOST $BASE/v1/accounts/$A/conversations/$C/messages -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"Вітаю! Так, є в наявності.","idempotencyKey":"'$(uuidgen)'"}'
curl -N "$BASE/v1/accounts/$A/events/stream?afterSequence=0" -H "authorization: Bearer $KEY"
```
