# Implementation plan (5 stages)

1. **Mock end-to-end** — monorepo, SQLite/Drizzle migrations, connector-core types, Fastify `/v1` API with hashed API keys, mock adapter, dev console, SSE.
2. **Persistent sessions** — Playwright `launchPersistentContext` per account at `${HEPSON_DATA_DIR}/profiles/<uuid>`, profile lock, identity check, login_required/checkpoint fallback, explicit forget, boot-time autostart. Verified against a local fake-Instagram server in real Chromium.
3. **Browser reading** — inbox/thread parsing (`selectors.ts` + `parsers.ts`), cache, fingerprint dedupe, `message.received` once.
4. **Browser sending** — per-account serialized queue, `outboundEnabled`, idempotency, UI verification, `uncertain` handling.
5. **Hardening/docs** — crash reconnect, redaction, graceful shutdown, replay, example client, docs.

Real Instagram is **not** reachable from this environment; items in `docs/MANUAL_INSTAGRAM_TEST.md` are untested until a human runs them.
