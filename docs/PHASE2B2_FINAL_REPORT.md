# StorePilot Phase 2B.2 — Shopify OAuth Connectivity Final Report

## 1. Objective

Phase 2B.2 validated the complete Shopify OAuth authorization-code-grant round-trip
against the production Vercel deployment, using the minimum viable scope
configuration (zero scopes). The spike proves the application can complete a
real OAuth flow end-to-end without persisting token material.

## 2. Architecture

- **Server-side Route Handlers** (`src/app/api/shopify/authorize/route.ts`,
  `src/app/api/shopify/callback/route.ts`) — no client-side OAuth logic.
- **State protection**: short-lived httpOnly SameSite=Lax cookie carrying a
  HMAC-tagged nonce bound to `projectId` + `userId`.
- **HMAC verification**: constant-time comparison of Shopify callback signature.
- **Token exchange**: requests the 2026 expiring offline token shape
  (`expiring: "1"`), then discards all token values in-process.
- **Environment normalization**: `src/lib/shopify/env.ts` trims all required
  scalar env values and treats `SHOPIFY_SCOPES` as optional, defaulting to `""`.

## 3. Production Origin

```
https://storepilot-aslams-projects-6ad7cbd6.vercel.app
```

Shopify test shop: `0tsfz1-eg.myshopify.com`

## 4. Zero-Scope Connectivity Design

Phase 2B intentionally requests zero Shopify scopes. The generated authorization
URL contains `scope=` with no value. This is the documented Shopify behavior for
an empty scope list and was confirmed to complete the round-trip successfully.

## 5. CRLF Environment Incident

During initial Vercel environment variable setup, PowerShell's `echo "value" |
vercel env add NAME` pipeline captured the trailing `\r\n` as part of the
variable value. This produced:

- `client_id` ending with `%0D%0A`
- `scope=%0D%0A` instead of `scope=`
- `redirect_uri` contaminated with `\r\n`

### Permanent Fix

`src/lib/shopify/env.ts` now applies `.trim()` to all required scalar values
(`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_APP_URL`,
`SHOPIFY_API_VERSION`). `SHOPIFY_SCOPES` is optional: `process.env.SHOPIFY_SCOPES?.trim() ?? ""`.

This makes the application resilient to platform env UIs or CLI pipelines that
inject accidental whitespace, without masking genuine configuration errors for
required values.

## 6. Vercel Deployment Protection Incident

Initial production deployment had Vercel SSO/Deployment Protection enabled at the
team level, causing anonymous requests to redirect to `vercel.com/sso-api`. This
broke Shopify's unauthenticated callback requests.

Resolution: Deployment Protection was disabled/bypassed for the StorePilot
project, allowing public access to `/api/shopify/callback`.

## 7. Successful Real OAuth Round-Trip

Manually verified completion of the full flow:

```
authenticated StorePilot user
  → POST /api/shopify/authorize
  → Shopify authorization screen
  → GET /api/shopify/callback
  → state validation
  → Shopify HMAC validation
  → token exchange
  → safe redirect back to StorePilot
  → ?shopify_spike=ok&shop=0tsfz1-eg.myshopify.com
```

UI displayed: "Shopify authorization successful"

## 8. Security Properties Verified

- `SHOPIFY_CLIENT_SECRET` never leaves `src/lib/shopify/` — confirmed by
  source-inspection tests and route grep checks.
- Token exchange response is consumed in-process; `body` goes out of scope
  immediately; only non-secret metadata is logged.
- State cookie: httpOnly, Secure, SameSite=Lax, Path=/, 10-minute maxAge,
  no explicit Domain attribute.
- `redirect_uri` is built from the fixed `SHOPIFY_APP_URL` config, never from
  the incoming request's host.
- No access token, refresh token, or connection metadata is returned to the
  browser in any form.

## 9. What Is NOT Persisted

The connectivity spike intentionally does NOT persist:

- access token
- refresh token
- Shopify connection record
- installation metadata
- granted scopes
- shop connection status

All token material is discarded after the non-secret metadata is extracted for
logging. Persistence is the explicit responsibility of Phase 2B.3.

## 10. Demo-Only Downstream Wizard State

After the successful OAuth spike, the wizard continues to display demo/sample
data in downstream screens. These values are NOT sourced from Shopify:

- 842 Products
- 18 Collections
- 7 Issues
- 87% readiness
- 6/6 setup
- 18 generated collections
- navigation/pages/etc.

These are hardcoded demo values for UI validation only.

## 11. Quality Gates

| Gate | Result |
|------|--------|
| `npm run test:shopify` | 46 assertions passed |
| `npm run check:css` | passed |
| `npm run lint` | passed (0 errors, 0 warnings) |
| `npx tsc --noEmit` | passed |
| `npm run build` | passed |

## 12. Phase 2B.3 Handoff

Phase 2B.3 will implement secure persistence of the Shopify connection:

- `sp_shopify_connections` table for non-secret metadata
- Supabase Vault for encrypted token material
- SECURITY DEFINER functions for narrowly scoped data access
- Reconnect, disconnect, and webhook preparation
- Connection status visible in wizard UI

No token material, connection state, or Shopify metadata from Phase 2B.2 should
be carried forward into Phase 2B.3 as persisted state — the spike was
intentionally stateless.
