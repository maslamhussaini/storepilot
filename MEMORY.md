# StorePilot — Project Memory

Verified project state only. No secrets, tokens, passwords, or service-role
values belong in this file. Source of truth for the numbers below is the
read-only production verification in `PHASE_2B_3B_3C_OAUTH_CUTOVER_EXECUTION_REPORT.txt`.

## Current phase

Phase 2B.3B — Shopify OAuth hardening (token lifecycle, disconnect/reconnect,
stable production origin). Current task: **2B.3B-3D, connected-state Reconnect
UI.** The control is implemented and passes all local quality gates. Whether
it is live in production is a moving target — treat "Next planned work" below
as the authority on what still has to happen, not this sentence.

## Production

- Origin: `https://storepilot-aslams-projects-6ad7cbd6.vercel.app`
- Stable Vercel OAuth origin: **verified**. Callback canary returns
  `307` same-origin `shopify_error=state_invalid`; no Vercel SSO, no
  Deployment Protection, no 401/403.
- Production `SHOPIFY_APP_URL` is **already the stable Vercel origin** (no
  trailing slash, no CR/LF, byte-verified). It was never the Cloudflare
  tunnel value — earlier reports that said otherwise were quoting the local
  `.env.local` value.
- Local `.env.local` still holds the old tunnel URL. Local only; not loaded
  in production. Not yet updated.

## Phase 2B.3B-3 implementation status

- Durable, Vault-backed connection model with credential generation
  (`credential_version`) and a refresh lease. Implemented and shipped.
- Disconnect lifecycle shipped: `revoke_connection_tokens` deletes the secret,
  clears token metadata and lease, marks the row disconnected, logs exactly
  one `disconnected` event, and preserves `credential_version` for audit.
- Reauthorize-while-connected was already supported server-side (the
  idempotent UPDATE branch of `store_connection_tokens` reuses the active row,
  +1 credential generation, logs `reconnected`). Until 3D there was **no UI**
  to reach it — the connected branch rendered only Disconnect.
- **Reconnect UI (3D)**: connected state now renders a secondary
  "Reconnect Shopify" control that posts the same
  `POST /api/shopify/authorize` form (hidden `projectId` + durable
  `connection.shopDomain`) already used by the Connect flow. No new API
  route, no second OAuth implementation, no disconnect-first, no change to
  token lifecycle, migrations, schema, or scopes.

## Production incident

A production incident destroyed the original Royal Oud refresh token (the
first disconnect revoked it). Recovery was completed through a **genuine
Shopify authorize/callback round trip** — not a repair, not a manual write.
The `2 disconnected` and `3 reconnected` events are accurate audit records and
must be retained, never deleted.

## Royal Oud — verified baseline

| Field | Value |
| --- | --- |
| shop | `0tsfz1-eg.myshopify.com` |
| project | Royal Oud |
| status | `connected` |
| `credential_version` | 6 |
| disconnected events | 2 |
| reconnected events | 3 |
| total lifecycle events | 8 |
| connections rows for project | 1 |
| linked credential secret | 1 |
| orphan secrets | 0 |
| refresh claim held | no |

Reconnect must move this to `credential_version` 7, reconnected 4, total 9,
disconnected **unchanged at 2**, still 1 linked / 0 orphans.

> Disconnect-then-connect is NOT an acceptable substitute: it makes
> `store_connection_tokens` take its INSERT branch, which resets
> `credential_version` to 1, adds a `disconnected` event, and leaves a second
> connection row. That is why 3D adds Reconnect instead.

## Zero scopes

**Zero Shopify scopes are currently granted** (`SHOPIFY_SCOPES` intentionally
absent; `granted_scopes` is empty). This is deliberate for the connectivity
phase, not an oversight. It is orthogonal to the OAuth origin work.

## Open item

**Migration history discrepancy — documented, unresolved.** A previous repair
operation erased 16 dashboard-applied versions from the remote migration
history table, leaving it incomplete relative to the local files. This is
recorded and was deliberately left alone; do not attempt a repair as a
side effect of unrelated work.

## Next planned work

1. Verify the 3D Reconnect control in the browser: confirm the Shopify consent
   URL's `redirect_uri` is the stable Vercel callback, then approve once, then
   re-check the Royal Oud baseline above.
2. Only after that passes, request the **minimum Catalog scopes** and the
   first real catalog import. Zero scopes is the blocker for any real catalog
   work.
3. Tidy-up candidates (not blockers): remove the obsolete trycloudflare
   redirect URL from the Shopify dashboard once the new origin is proven;
   update the stale tunnel URL in local `.env.local`.
