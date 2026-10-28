# Future: Meta official API adapter (`instagram-official`)

**Plug-in point:** implement `MessagingAdapter` (`packages/connector-core/src/types.ts`) as `packages/instagram-official` and register it for `connectorType: 'instagram-official'` in `buildApp` (`apps/api/src/server.ts`). Public API, DB and console stay unchanged.

## Mapping
| Hepson | Meta Instagram Messaging API |
|---|---|
| `store_accounts.id` | internal; map to IG professional account id (`ig_user_id`) in a new `provider_account_ref` column (non-secret) |
| `conversations.providerId` | Conversation id from `GET /{ig-user-id}/conversations?platform=instagram` (or `IGSID` pair) |
| `participants` | IGSID of the customer + `username` from User Profile API |
| `messages.providerId` | `mid` of the message (`GET /{conversation-id}?fields=messages{id,message,from,created_time}`) |
| `sentAt` | `created_time` (always known → fewer `null`s) |
| `direction` | `from.id == ig_user_id` ⇒ outgoing |
| attachments | webhook/Graph `attachments` → `image|video|audio|other` metadata |
| send | `POST /{ig-user-id}/messages` `{recipient:{id:IGSID}, message:{text}}` (scope `instagram_business_manage_messages`); use own idempotency (outbox) — Graph has no idempotency key |

`providerMessageId` becomes reliable, so `messageFingerprint` takes its `pid:` path and dedupe is exact.

## Webhooks
Add `POST /v1/webhooks/meta` (+ `GET` for the `hub.challenge` handshake with `hub.verify_token`). Verify `X-Hub-Signature-256` = HMAC-SHA256(raw body, app secret) with constant-time compare **before** parsing. Resolve the account from `entry[].id`, persist the event, then publish `message.received` via the existing `EventBus`. Replace polling for this adapter (`listConversations` remains for backfill). Tokens (long-lived IG user tokens) belong in an encrypted secret store/KMS — add a dedicated table with envelope encryption; never plain columns. Respect the 24-hour standard messaging window: surface `TEMPORARY_FAILURE`/new error `OUTSIDE_MESSAGING_WINDOW` on send.

## Auth / onboarding
Instagram Login (business login) OAuth flow in the console replaces the visible browser: the owner consents on instagram.com and the token is stored; `connect()` validates the token and returns `connected`/`login_required` (token expired). Requires Meta App Review for `instagram_business_manage_messages` and the shop to be a professional account.

## Migration plan
1. Build adapter behind a feature flag; run in mock+official contract tests (`adapterContract`).
2. Pilot with one shop in parallel: official adapter reads, browser adapter paused.
3. Per account: create new `instagram-official` account, import history via Graph, map to existing conversation rows by IGSID/handle (manual review), flip consumers to the new account id, forget the browser profile.
4. Retire the browser adapter once all pilots migrate.
