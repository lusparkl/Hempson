# Hepson HTTP API v1

Base: `http://127.0.0.1:8787` (loopback by default). OpenAPI with every route and schema: `GET /v1/openapi.json` or `pnpm openapi` → `docs/openapi.json`.

## Shop API
Dashboard users authenticate with `Authorization: Bearer hsu_…` from `POST /v1/auth/login` (or `/register`). These routes reject `hep_` API keys. Every `/v1/shops/:shopId/...` route checks membership; a shop the user is not a member of is `404`, an owner-only write by a manager is `403`.
```
GET    /health · /ready
POST   /v1/auth/register|login|logout   GET /v1/auth/me
GET|POST /v1/shops   GET|PATCH /v1/shops/:shopId   members: GET|POST .../members, PATCH|DELETE .../members/:userId
catalog: .../products[/:productId[/variants[/:variantId[/stock]]]], POST .../products/import {csv, dryRun}, POST .../products/import-xlsx {file: base64, dryRun}, POST .../products/import-sheet {url, dryRun} (owner); GET .../photo-index (any member), POST .../photo-index/retry (owner)
chats:   GET .../customers, GET .../conversations[/:id], GET|POST .../conversations/:id/messages, PUT .../conversations/:id/ai {paused}
agent:   GET|PUT .../ai {enabled, instructions, autonomy, autoConfirmMaxMinor}, GET .../ai/runs, GET .../escalations, POST .../escalations/:id/resolve
orders:  GET .../order-drafts[/:draftId] (each with `customerNotices`: event, state, code, at), GET .../order-drafts/export.xlsx?from&to&status, GET .../order-drafts/:draftId/events|payments,
         POST .../order-drafts/:draftId/approve|reject|cancel|returned {restock?}|ttn|ttn/release|payment-link|refund-requested
policies (P3): GET .../policies, PUT .../policies/:topic {text}   topic = delivery|returns|payment|hours (owner writes)
nova poshta (P4): GET .../nova-poshta, PUT|DELETE .../nova-poshta/key {apiKey}, PUT .../nova-poshta/settings,
         GET .../nova-poshta/cities?q, GET .../nova-poshta/branches?cityRef&q,
         GET|POST .../customers/:customerId/refusals, DELETE .../customers/:customerId/refusals/:refusalId
monobank (P5): GET .../monobank, PUT|DELETE .../monobank/token {token}, PUT .../monobank/settings {paymentTimeoutHours, reminderHoursBefore}
other:   GET|PUT .../notifications, GET .../stats?from&to (includes `usage`, `funnel`, `orderSources`), GET .../usage, PUT .../plan {plan, customCap?} (admin key), GET|PUT .../web-chat, POST .../web-chat/rotate-key
instagram (official, D29): GET|DELETE .../instagram, POST .../instagram/connect
telegram (shop bot, D27): GET|PUT {token}|DELETE .../telegram
public:  POST /public/web-chat/:widgetKey/session, POST|GET /public/web-chat/:widgetKey/messages, GET /widget/web-chat.js
         GET /public/instagram/callback (OAuth), GET|POST /webhooks/instagram (handshake, signed events; not in OpenAPI)
         POST /webhooks/telegram/:webhookId (X-Telegram-Bot-Api-Secret-Token required)
         POST /webhooks/monobank/:webhookId (x-sign ECDSA signature over the raw body required)
```

## Operator API key
`PUT /v1/shops/:shopId/plan {plan?, customCap?, paidUntil?}` takes `Authorization: Bearer hep_…`, an operator key from `pnpm bootstrap-key [name]` (shown once; only its SHA-256 hash is stored). It is a fallback for setting a shop's plan by hand (D41). `paidUntil` is the last paid day as `YYYY-MM-DD` (Kyiv, inclusive); `null` removes the expiry. `{paidUntil}` alone renews and keeps the plan and custom cap (D48). Every other `/v1/shops/...` route rejects these keys, and this route rejects user sessions.

## Errors
Always `{ "error": { "code", "message", "retryable" } }` (`apps/api/src/errors.ts`).

| code | HTTP | meaning |
|---|---|---|
| `UNAUTHORIZED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 · `VALIDATION_ERROR` 400 | | |
| `LOGIN_REQUIRED` | 409 | Instagram did not accept the connection; the owner connects again |
| `ACCOUNT_NOT_CONNECTED` | 409 | no connected channel can reach the conversation |
| `OUTSIDE_MESSAGING_WINDOW` | 409 | Instagram's 24-hour messaging window has closed |
| `NOT_CONFIGURED` | 503 | the operator has not configured this integration |
| `TEMPORARY_FAILURE` | 503 | transient, `retryable:true` |
| `RATE_LIMITED_OR_BLOCKED` | 429 | rate limited (`Retry-After` on website chat) |
| `INTERNAL` | 500 | unexpected error |
