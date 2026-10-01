# StorePilot — Project Memory

Verified project state only. No secrets, tokens, passwords, or service-role
values belong in this file. Source of truth for the numbers below is the
read-only production verification in
`PHASE_2B_3B_3D_POST_RECONNECT_VERIFICATION.txt`.

## Current phase

**Phase 2B.3B-3D: PASS.** Reconnect UI shipped, deployed, and exercised once
against production. Phase 2B.3B-3E (post-reconnect cleanup) is the task in
flight. Next planned phase is 2C.

3E in flight: the Disconnect confirmation modal's destructive button was
present but **invisible** — `bg-[var(--sp-red-600)]` referenced a custom
property `globals.css` never defined, so the background resolved to
`transparent` under white text on a white dialog. Six design tokens
(`--sp-red-50/400/600/700/900`, `--sp-fg`) were undefined and used in exactly
one file. Fixed by defining them; a test now fails if the component references
any `--sp-*` token that `globals.css` does not define. Not yet deployed.

## Production

- Origin: `https://storepilot-aslams-projects-6ad7cbd6.vercel.app`
- Stable Vercel OAuth origin: **verified**. Callback canary returns
  `307` same-origin `shopify_error=state_invalid`; no Vercel SSO, no
  Deployment Protection, no 401/403.
- Production `SHOPIFY_APP_URL` is **already the stable Vercel origin** (no
  trailing slash, no CR/LF, byte-verified). It was never the Cloudflare
  tunnel value — earlier reports that said otherwise were quoting the local
  `.env.local` value.
- Local `.env.local` was updated in 3E: `SHOPIFY_APP_URL` now points at the
  stable Vercel origin instead of the stale tunnel URL. One line changed; no
  other variable touched. `.env.local` remains gitignored and untracked.

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

## Royal Oud — verified state AFTER the 3D reconnect (PASS)

Read-only verification, 2026-09-30T21:01Z. Zero writes.

| Field | Before 3D | After 3D |
| --- | --- | --- |
| shop | `0tsfz1-eg.myshopify.com` | unchanged |
| project | Royal Oud | unchanged |
| status | `connected` | `connected` |
| `credential_version` | 6 | **7** |
| disconnected events | 2 | **2** (unchanged) |
| reconnected events | 3 | **4** |
| total lifecycle events | 8 | **9** |
| connection rows | 1 | **1** (no duplicate) |
| refresh claim held | no | **no** |
| `disconnected_at` | null | null |
| `granted_scopes` | `[]` | **`[]`** (still zero) |
| `installed_at` | 2026-09-23T07:40:22Z | **unchanged** |

The human reconnect ran **exactly once**. Expected transition matched in full:
`credential_version` +1, `reconnected` +1, `disconnected` unchanged, total +1,
one row, one linked reference, no refresh claim.

Three independent proofs that the intended code path ran, not a disconnect /
reconnect cycle: `credential_version` is 7 and not 1 (the UPDATE branch, not
INSERT); `installed_at` is bit-identical to the original install; and exactly
one event exists after the previous verified newest event.

Event metadata carries no credential material — the newest `reconnected` event
holds only `{"shop_domain": "..."}`.

### Disconnect confirmation modal was opened by accident

The human opened the Disconnect confirmation modal afterwards and did **not**
confirm it. **It caused zero mutation**: `disconnected` stayed 2, status stayed
`connected`, `disconnected_at` stayed null, `credential_version` stayed 7. The
trigger is `type="button"` and only sets local state, so it could not submit;
the revoke lives in a separate server action inside the modal's own form.

## Vault references — what is and is not verified

- The connected row has **one non-null Vault reference**, resolving to exactly
  one distinct `vault_secret_id`. No connected row lacks a reference.
- A fresh **total** Vault secret count and a fresh **orphan** count were
  **unavailable in the verification environment**: `vault.secrets` is not served
  by PostgREST, no Supabase personal access token is present, `.env.local` has
  no database password, and the Supabase MCP server is not reachable from the
  agent toolset. Treat totals and orphans as **not measured**, not as zero.
- No Vault plaintext was ever read or decrypted.

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

**Phase 2C — minimum Shopify Catalog scopes + first real catalog import.**
Zero granted scopes is now the only blocker to any real catalog functionality.
Reconnect and the stable origin are proven and must not be revisited.

Remaining tidy-up, non-blocking:

1. Remove the obsolete redirect URL from the Shopify dashboard, if it is still
   listed: `https://kelkoo-ground-treo-clerk.trycloudflare.com/api/shopify/callback`.
   Remove ONLY that entry, and only after confirming the stable Vercel callback
   `https://storepilot-aslams-projects-6ad7cbd6.vercel.app/api/shopify/callback`
   is present in the ACTIVE config version. Dashboard mutation needs human
   browser access; the agent has none.
2. Vault total/orphan counts remain unmeasurable from the agent environment.
