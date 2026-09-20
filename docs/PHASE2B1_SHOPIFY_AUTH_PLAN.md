# StorePilot Phase 2B.1 — Shopify Authorization Architecture & Pre-Flight

**Status: architecture/plan only. No OAuth code, no migrations, no commits in this phase.**
Baseline: Phase 2A frozen at `a8b34fd` — untouched by this document.

---

## 1. Current Shopify requirements verified (2026)

Verified against `shopify.dev` directly (not older tutorials), September 2026.

### Distribution/auth model for StorePilot's shape
StorePilot is a **standalone, non-embedded, multi-merchant (public) app** — it lives entirely
outside the Shopify Admin iframe, in StorePilot's own Next.js UI. Shopify's current docs draw a
hard line here: **Shopify Managed Installation / token exchange is only for apps embedded in the
Shopify Admin**, built and run via Shopify CLI. For an app "outside the Shopify admin," Shopify's
own guidance is that the **classic OAuth authorization code grant remains the correct, current
path** — this is not a legacy fallback, it is still the documented recommendation for our exact
architecture.

### Authorization flow (confirmed exact shape)
1. Redirect the merchant to:
   `https://{shop}.myshopify.com/admin/oauth/authorize?client_id={id}&scope={scopes}&redirect_uri={uri}&state={nonce}`
2. Merchant approves in Shopify's UI.
3. Shopify redirects back to our `redirect_uri` with: `code`, `hmac`, `shop`, `state`, `timestamp`
   (and `host` if launched from certain entry points).
4. We validate (in this order — cheapest/most likely to reject first):
   - **State**: compare against the nonce we generated and stored server-side; reject on mismatch
     (CSRF/replay protection).
   - **HMAC**: remove `hmac` from the query string, sort remaining params lexicographically, join
     as `key=value` pairs with `&`, compute `HMAC-SHA256` using our app's client secret, compare
     with **constant-time comparison** (`crypto.timingSafeEqual` in Node — never `===`).
   - **Shop domain**: must match `^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$` (anchored both
     ends) before it is used in any URL, query, or stored anywhere.
5. Exchange `code` for a token: `POST https://{shop}/admin/oauth/access_token` with `client_id`,
   `client_secret`, `code`, **and `expiring: "1"`** (see below — this is now required for new
   public apps).

### Offline vs. online tokens, and the 2026 change that actually matters
- **Offline tokens** (long-lived, not tied to a specific browser session) are the right choice for
  StorePilot: our background build jobs (Phase 2E) run without a merchant present, so we need a
  token that persists independent of any user session. This confirms the original Phase 2A
  foundation report's assumption.
- **The 2026 change**: starting **April 1, 2026**, Shopify requires all **new public apps** to
  request **expiring offline access tokens** — a real `access_token` + `refresh_token` pair with an
  `expires_in` window, refreshed via OAuth2-style refresh-token exchange, instead of the old
  non-expiring static offline token. Since StorePilot is a new public app built after this date,
  **we must implement token refresh from day one** — this is not optional and not a future
  migration; it changes the data model (we need to store a refresh token and an expiry, not just
  an access token) and requires a background refresh mechanism (proactively refresh ~60s before
  expiry, per Shopify's guidance) so a stale token never blocks a build job mid-flight.
- Static/legacy private-app API tokens are being phased out entirely by January 1, 2026 — not
  relevant to us since we were never using that model, but confirms Shopify's direction is fully
  behind the expiring-token model industry-wide.

### Scopes
Requested via the `scope` param as a comma-separated list at authorization time. Shopify supports
**incremental (optional) scopes** — an already-installed app can request additional scopes later
via a new authorization round-trip without forcing a full reinstall, which materially changes our
scope strategy (see §4).

### Redirect/callback URL requirements
Must be **HTTPS** (loopback/localhost only exempted for local dev via Shopify CLI tunneling, which
doesn't apply to our architecture) and must **exactly match** one of the URLs registered in the
Partner/Dev Dashboard app configuration — no wildcard matching, no path-suffix tolerance.

### Uninstall handling
Shopify fires an `app/uninstalled` webhook when a merchant removes the app. We must handle this to
mark the connection `disconnected` — Shopify does **not** notify us of a *reconnect*; a fresh
install just runs the OAuth flow again.

### Mandatory webhooks
If StorePilot is ever distributed through the **Shopify App Store**, three GDPR compliance
webhooks become mandatory and are checked by Shopify's review process: `customers/data_request`
(30 days to respond), `customers/redact` (30 days to purge), `shop/redact` (48 hours to purge all
store data after uninstall+deletion request). **This is distribution-model-dependent**: if
StorePilot is initially run as an unlisted/direct-install public app (not submitted to the App
Store), these are not enforced by Shopify's review, but implementing `shop/redact`-equivalent
behavior (purging `sp_shopify_connections` on uninstall) is good practice regardless and cheap to
do at the same time as `app/uninstalled`.

### API version
Current stable: **2026-07** (three-month release cadence, ~12-month support window per version,
~9 months overlap). We should pin an explicit version string in every Admin API call rather than
floating on "latest," per Shopify's own versioning guidance, and plan a periodic bump.

### What this changes vs. "traditional OAuth assumptions"
The token model is the one real 2026-specific shift: a naive implementation that stores a single
non-expiring `access_token` (as most older tutorials still show) would be **wrong today** for a
new public app. Everything else (authorization code grant shape, HMAC/state/shop validation,
redirect URL exact-match) is unchanged from the classic flow.

**Sources:**
- [About app authentication](https://shopify.dev/docs/apps/build/authentication-authorization)
- [Implement authorization code grant manually](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant)
- [About offline access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md)
- [Access tokens overview](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
- [Privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)
- [Webhooks reference](https://shopify.dev/docs/api/webhooks/latest)
- [About Shopify API versioning](https://shopify.dev/docs/api/usage/versioning)
- [2026-07 release notes](https://shopify.dev/release-notes/2026-07)

---

## 2. Existing StorePilot Shopify stub inventory

| Location | Current state |
|---|---|
| `src/lib/shopify/index.ts` | Placeholder only. `ShopifyConnection` type (`connected`, `shopDomain?`, `connectedAt?`) and `connectDemoStore()`, which returns a hardcoded fake connection after an `await` with no network call. No OAuth, no HTTP client, no token handling of any kind exists today. |
| `src/app/projects/[projectId]/wizard/[step]/WizardStepView.tsx` — `ConnectStep` | Calls `connectDemoStore()` from a button click, flips local `connected` state, shows "✓ Demo store connected" with a fake `demo-store.myshopify.com` domain. Entirely client-side, ephemeral, resets on navigation (per the "Wizard State UX Correction" work, this now *feels* sticky across navigation because the surrounding demo-catalog session-state pattern exists, but Connect itself was not wired into that pattern — it still resets today). Nothing is persisted to Supabase for this step. |
| `src/lib/projects/queries.ts` / `actions.ts` | No Shopify-aware code paths. `advanceWizardAction` persists `current_step`/`progress_percent` generically for every step including `connect`, but has no concept of "was a real store actually connected." |
| `src/lib/supabase/types.ts` | Only `SpProject` and `SpBusinessProfile`. No Shopify-related table exists yet. |
| `.env.example` | No Shopify variables present at all — `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`/etc. do not exist yet. |
| `src/proxy.ts` | Route protection only covers `/` and `/projects/*` (Supabase session). It has no awareness of a future `/api/shopify/*` or `/projects/[projectId]/shopify/callback` route — those would need explicit inclusion/exclusion decisions (see §5). |

**Conclusion:** there is nothing to migrate or unwind — this is a clean-slate build on top of the
Phase 2A project/auth foundation, not a refactor of partially-real Shopify code.

---

## 3. Proposed database/security architecture

### Decision: split client-safe metadata from the credential, in two tables

A single `sp_shopify_connections` table containing the access/refresh token **and** being
readable by the normal authenticated client (even under RLS scoped to the owner) is the wrong
shape for this data, for a reason that doesn't apply to `sp_projects`/`sp_business_profiles`:
those tables hold data the owner is *supposed* to read directly from the browser (via
`createSupabaseServerClient`, itself using the user's own JWT). A Shopify access token must
**never** be readable through that path at all, even by its rightful owner's own browser session —
the browser has no legitimate reason to ever see it; only StorePilot's own server code (building
resources, making Admin API calls) needs it. RLS scoped to `auth.uid()` correctly prevents
*other* tenants from reading it, but it does nothing to prevent the *owning* tenant's own client
JS from fetching it over PostgREST if a bug ever queried `sp_shopify_connections` from a client
component instead of a server one. Two tables closes that gap structurally instead of relying on
"we would never write that query":

- **`sp_shopify_connections`** — client-safe connection *metadata*. Readable under normal RLS by
  the owning user (so the UI can show "Connected to royal-oud.myshopify.com" without a server
  round trip if ever needed). Contains **no secret material**.
- **`sp_shopify_credentials`** — server-only. RLS enabled and forced, but with **zero policies for
  the `authenticated` role** — same pattern already used for `anon` on the Phase 2A tables
  (§5 of the Phase 2A RLS design: "no policy at all" fails closed by construction, not by
  vigilance). The only way to reach this table is a server-side Supabase client, and even that
  should go through a `SECURITY DEFINER` RPC (not a raw `.from("sp_shopify_credentials")` call)
  scoped to "the caller's own connection," so a future bug in application code can't accidentally
  `select *` this table and leak a token into a server log or an error response.

### Fields

**`sp_shopify_connections`** (client-readable metadata):
```
id                uuid primary key default gen_random_uuid()
project_id        uuid not null references sp_projects(id) on delete cascade
user_id           uuid not null references auth.users(id) on delete cascade
shop_domain       text not null              -- "royal-oud.myshopify.com", validated format
shop_id           bigint                     -- Shopify's numeric shop id, from the shop query
shop_name         text                       -- display name, from the shop query
scopes            text not null              -- comma-separated, what was actually granted
status            text not null default 'connected'
                    check (status in ('connected', 'disconnected', 'revoked'))
installed_at      timestamptz not null default now()
disconnected_at   timestamptz
created_at        timestamptz not null default now()
updated_at        timestamptz not null default now()
unique (project_id)   -- one active Shopify connection per project, see below
```

**`sp_shopify_credentials`** (server-only, no client policies at all):
```
connection_id       uuid primary key references sp_shopify_connections(id) on delete cascade
access_token        text not null      -- encrypted at rest, see below — never plaintext in the column
refresh_token        text not null      -- 2026 requirement: expiring tokens need this
access_token_expires_at   timestamptz not null
created_at           timestamptz not null default now()
updated_at           timestamptz not null default now()
```

### user_id duplication — yes, keep it
Mirroring `user_id` onto `sp_shopify_connections` (in addition to the `project_id` FK) is
deliberate and consistent with the exact pattern already established for
`sp_business_profiles`: it lets the RLS policy check ownership directly without a join on every
statement, while the `project_id` FK is *additionally* validated via an `EXISTS` against
`sp_projects` — same double-check rationale as Phase 2A, for the same reason (a forged
`project_id` alone, or a forged `user_id` alone, must each independently fail).

### One active connection per project — yes, enforce it
A `unique(project_id)` constraint on `sp_shopify_connections` is correct for the current product
shape: StorePilot's wizard model is "one project = one store being launched," and the UI has no
concept of multiple simultaneous Shopify targets per project. Reconnecting to a *different* shop
should be modeled as **disconnect, then a fresh OAuth round-trip**, not as a second row — this
also keeps "which token do we use for this project's build job" unambiguous by construction
(no need for an `is_primary` flag or similar).

### Token encryption at rest
`access_token`/`refresh_token` must not sit in `sp_shopify_credentials` as plain `text` in
practice, even though RLS blocks client access — RLS is a *Postgres-level* access-control
boundary, not encryption, and doesn't protect against a Supabase project-level credential leak,
a misconfigured backup, or a future `SECURITY DEFINER` function bug. Use **Supabase Vault**
(`pgsodium`-backed, purpose-built for exactly this: encrypted secrets referenced by an opaque ID,
decrypted only through a Vault-provided function call, itself further restrictable). This is a
`CREATE EXTENSION`/Vault-table concern for whoever implements Phase 2B.2, not something to design
further here, but the decision to use it (rather than plain columns) belongs in this plan.

### RLS summary
- `sp_shopify_connections`: 4 policies (select/insert/update/delete), each `user_id = auth.uid()`
  **and** `exists (select 1 from sp_projects where id = project_id and user_id = auth.uid())` —
  identical shape to `sp_business_profiles`'s policies today. RLS enabled + forced.
- `sp_shopify_credentials`: RLS enabled + forced, **zero policies**. All access happens through a
  `SECURITY DEFINER` function (e.g. `sp_get_shopify_token(connection_id uuid)`) that itself
  re-checks the caller owns the connection before decrypting/returning anything — belt-and-braces
  even though only server code should ever call it.
- **Existing Phase 2A migrations and policies are not touched.** This is strictly additive.

### Disconnect/uninstall
- **User-initiated disconnect** (in-app "Disconnect" button): a server action sets
  `status = 'disconnected'`, `disconnected_at = now()`, and deletes the row in
  `sp_shopify_credentials` (not just the token value — the whole row), then optionally attempts a
  best-effort Shopify-side token revocation. `sp_shopify_connections` itself is kept (not deleted)
  so the UI can show connection history / "previously connected to X."
- **Shopify-initiated uninstall** (`app/uninstalled` webhook): same effect — the webhook handler
  looks up the connection by `shop_domain`, sets the same `disconnected`/`disconnected_at`, deletes
  the credentials row. The webhook must verify the request's HMAC header (a different mechanism
  than the OAuth callback's query-param HMAC — webhooks sign the raw request body with
  `X-Shopify-Hmac-Sha256`) before trusting it.

---

## 4. Proposed scopes

Because Shopify supports **incremental scope requests** (confirmed in §1), StorePilot should ask
for the minimum that Phase 2B.1's own goal — "identify the shop and persist a working connection"
— actually requires, and request more later exactly when the feature that needs it ships, via a
fresh authorization round-trip. This avoids an early, unnecessarily broad ask that would look bad
in Shopify's app review and demands more merchant trust than we've earned at Connect-step time.

**Required now (Phase 2B.2 — the actual OAuth implementation):**
- None beyond the base authenticated connection are strictly required to query
  `shop { id, name, myshopifyDomain }` via the GraphQL Admin API for identification — Shopify's
  Admin API allows reading basic shop info with just a valid access token. If Shopify's current
  scope model requires *some* non-empty `scope` param regardless (needs to be re-verified against
  the live Partner Dashboard at implementation time — the docs don't fully resolve whether a
  literal empty scope is accepted), the minimal fallback is **`read_products`** (read-only,
  harmless, and something Phase 2C will need imminently anyway).

**Required later (Phase 2C — catalog ingestion):**
- `read_products`, `write_products` (create products from the parsed catalog)
- `read_product_listings` if publishing to specific sales channels becomes relevant

**Required later (Phase 2D — blueprint engine: collections/navigation/pages):**
- `write_publications` (Shopify's current scope for collections/publishing surfaces — must be
  re-verified against the live scope reference at implementation time, since Shopify periodically
  renames/splits scopes across API versions)
- Navigation menu creation currently requires GraphQL Admin API scopes tied to `write_online_store`
  in some API versions — flagged as **needs re-verification at 2D implementation time**, not
  assumed here.

**Required later (Phase 2E — build queue, page/content creation):**
- Page-creation scopes (`write_content` or equivalent — same re-verification caveat)

**Explicitly NOT requested in Phase 2B.1 or its near-term follow-ups:**
- Theme access (`read_themes`/`write_themes`) — no approved use case yet, and theme scopes draw
  extra Shopify app-review scrutiny. Do not request until a concrete Phase (2F+?) actually needs
  to touch theme files, and treat that as a separate scope/review decision when it happens.
- Any customer-data scope (`read_customers`, etc.) — StorePilot's roadmap has no customer-data
  use case at all; requesting it would trigger the GDPR mandatory-webhook requirement (§1) for no
  product reason.
- Order data, discounts, or anything outside "build the store's product/content structure."

---

## 5. Proposed routes/flow

```
src/app/projects/[projectId]/wizard/[step]/WizardStepView.tsx  (ConnectStep)
  "Connect Shopify →" button
    → POST src/app/api/shopify/authorize/route.ts   (Route Handler, not a Server Action —
        needs to issue a 302 redirect to a *different origin*, which Server Actions handle
        awkwardly; a Route Handler returning NextResponse.redirect is the clean fit)
        - requireUser() (re-verify session server-side, same DAL as Phase 2A)
        - verify projectId belongs to the caller (reuse getProjectWithProfile-style check)
        - generate a cryptographically random state nonce
        - store { projectId, userId, nonce, createdAt } server-side — a short-lived signed
          httpOnly cookie is sufficient (no new table needed just for this; it's a ≤10-minute
          CSRF token, not durable data) — NOT sessionStorage/localStorage (client-readable)
        - build the Shopify authorize URL (shop domain from a form field the user typed,
          normalized/validated — see §6) and issue redirect

  ↓ merchant approves on Shopify ↓

src/app/api/shopify/callback/route.ts   (Route Handler — Shopify redirects here directly,
        this cannot be a page component since it must run server logic before any render)
    - re-derive state cookie, compare to `state` query param — reject on mismatch (log + friendly
      error page, never a raw 500)
    - HMAC-verify the full query string using the app's client secret, constant-time compare
    - validate `shop` against the anchored myshopify.com regex
    - exchange `code` for tokens (expiring=1) — server-only fetch, response never touches the
      client
    - call the GraphQL Admin API `shop` query to get shop id/name for display
    - upsert sp_shopify_connections (client-safe row) + sp_shopify_credentials (server-only row,
      inside a transaction so a partial write can't leave a connection row with no credentials)
    - clear the state cookie
    - redirect to /projects/[projectId]/wizard/connect (back into the same project's wizard,
      per the goal statement) with a success indicator

src/app/api/shopify/disconnect/route.ts  (or a Server Action — this one CAN be a Server Action,
        since it doesn't need a cross-origin redirect)
    - requireUser(), verify ownership, set disconnected, delete credentials row

src/app/api/webhooks/shopify/uninstalled/route.ts
    - verify X-Shopify-Hmac-Sha256 header against raw body (different from the OAuth HMAC check —
      do not reuse the same helper naively; the input shape differs)
    - look up connection by shop_domain, mark disconnected, delete credentials
    - respond 200 fast (Shopify retries on non-2xx / timeout)
```

### `src/proxy.ts` change needed (design note, not implemented here)
`/api/shopify/callback` and `/api/webhooks/shopify/*` must be reachable **without** the existing
Supabase-session redirect-to-`/login` behavior interfering — Shopify's redirect back to our
callback is not going to carry our session cookie context in a way that matters (we re-derive the
user from our own state cookie, not from requiring an active Supabase session at that exact
moment), and a webhook call from Shopify's servers has no Supabase session at all. The proxy's
`PROTECTED_PREFIXES`/matcher will need an explicit exclusion for both `/api/shopify/*` paths —
call out that these routes do their **own** independent auth (state cookie / HMAC), matching the
existing pattern of "proxy is UX only, real checks live in the handler."

### Error/edge cases and how each is handled
| Case | Handling |
|---|---|
| Invalid shop domain typed by user | Reject before redirecting to Shopify at all — regex-validate client-side for UX and server-side (authoritative) in the authorize Route Handler |
| Merchant denies authorization | Shopify redirects back with no `code` (or an error param) — detect, show a calm "connection cancelled" state, no error logged as a failure |
| State mismatch | Reject with a generic "connection couldn't be verified, please try again" — never reveal *why* (avoids leaking timing/oracle info); log the mismatch server-side for our own monitoring |
| HMAC failure | Same generic rejection + server log; this is the highest-signal case for an actual attack attempt, worth its own log line/metric |
| Token exchange failure (Shopify's `/oauth/access_token` errors) | Show "we couldn't finish connecting your store," offer retry; do not surface Shopify's raw error body to the merchant |
| Duplicate store connection (project already has one) | Treat a new successful OAuth round-trip as an intentional reconnect: disconnect the old row (§3), upsert the new one — never silently create a second `sp_shopify_connections` row for the same project (the `unique(project_id)` constraint makes this a DB-level guarantee, not just an app-level convention) |
| Revoked/uninstalled app | `app/uninstalled` webhook handler (above); also treat a `401`/`invalid_token` response from any Admin API call as "connection is actually dead," mark `revoked`, prompt reconnect rather than silently retrying forever |

---

## 6. Proposed test plan

- **Unit — shop domain normalization/validation**: accepts `my-shop.myshopify.com`,
  `my-shop`(bare handle → normalized to full domain, a common UX nicety) rejects
  `evil.com`, `myshopify.com.evil.com`, embedded whitespace/control characters, anything not
  matching the anchored regex.
- **Unit — state generation/validation**: nonce is sufficiently random (source: `crypto.randomBytes`,
  not `Math.random()`), cookie is `httpOnly`+`secure`+short-lived, mismatch is rejected,
  **expired** state is rejected (not just wrong-value — a stale cookie replayed after its TTL must
  also fail).
- **Unit — HMAC validation**: known-good Shopify example query string validates true; a single
  flipped character anywhere in any param value validates false; verify constant-time comparison is
  actually used (not just correct output) since a naive `===`/`crypto.createHash` string compare
  is a timing side-channel.
- **Unit — authorization URL generation**: exact param set, param encoding, scope list formatting,
  `redirect_uri` matches the registered value exactly (byte-for-byte, including trailing slash
  presence/absence).
- **Integration — callback rejection paths**: each row of the §5 error table gets its own test
  hitting the actual Route Handler with a crafted request (bad state, bad HMAC, malformed shop,
  missing `code`), asserting the correct calm/generic response and that **no** row is written to
  either Shopify table on any rejected path.
- **Integration — cross-tenant connection isolation**: extend
  `supabase/tests/rls_security_tests.sql` with new scenarios in the same executable style as
  Phase 2A's A–H: User B cannot read/update/delete User A's `sp_shopify_connections` row; User B
  cannot read `sp_shopify_credentials` **at all**, including their own (no policies exist — prove
  a direct `select` as `authenticated` returns 0 rows/errors even for a row B legitimately owns,
  confirming access is only possible through the `SECURITY DEFINER` function); anonymous access
  denied on both tables.
- **Token non-exposure test**: assert the access/refresh token never appears in (a) any HTTP
  response body reachable from a client component, (b) the client-side JS bundle, (c) application
  logs — grep server logs from a full OAuth round-trip in a test environment for the literal token
  value and fail the test if found.
- **Reconnect/disconnect**: reconnect replaces the credentials row and does not create a second
  `sp_shopify_connections` row (constraint-backed, but also assert the app-level upsert path);
  disconnect deletes the credentials row and does not delete the connection metadata row.
- **Refresh/session persistence**: simulate an access token nearing `access_token_expires_at`,
  assert the refresh path runs and updates the stored expiry before a build-job-style API call is
  attempted; assert a build job started with an already-expired token proactively refreshes rather
  than failing the job.
- **Real Shopify development store acceptance test** (manual, cannot be executed by this session —
  needs a real Partner Dashboard app + a development store, exactly like Phase 2A's real-browser
  acceptance test needed a live Supabase project): full click-through — Connect → Shopify
  authorize screen → approve → redirected back to the correct project's wizard → connection shows
  as connected with the correct shop name/domain → uninstalling from the Shopify side (or from the
  Partner Dashboard test tools) correctly flips the connection to disconnected without any manual
  intervention.

---

## 7. Shopify Partner/Dev Dashboard configuration needed (not yet done)

- A Partner organization + a new **public app** entry (not "custom app" — StorePilot is
  multi-merchant).
- App URL and **exact** allowed redirect URL(s) registered — must match `redirect_uri` byte-for-byte,
  HTTPS only (a real deployed StorePilot domain; localhost won't satisfy Shopify's redirect
  requirement for this flow the way embedded-app CLI tunnels do).
- Client ID / client secret issued — these become `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`.
- `app/uninstalled` webhook subscription configured (either via the Dashboard's webhook config UI,
  or declared in the app's `shopify.app.toml`-equivalent if the eventual implementation uses
  Shopify CLI tooling — to be decided at 2B.2 implementation time).
- A development store created for the acceptance test in §6.
- A decision on whether GDPR compliance webhooks (§1) are configured now (cheap, low-risk to add
  early) even though they're only *mandated* if/when StorePilot is submitted to the App Store.

---

## 8. Environment variables StorePilot will eventually need

All server-only (**none** prefixed `NEXT_PUBLIC_*** — a Shopify client secret or access token in a
public variable would be a critical vulnerability, called out explicitly in the task's security
rules and consistent with how `SUPABASE_SERVICE_ROLE_KEY` is already documented in `.env.example`):

```
SHOPIFY_API_KEY=            # client_id from the Partner Dashboard app
SHOPIFY_API_SECRET=         # client_secret — used only for HMAC verification and token exchange
SHOPIFY_APP_URL=            # this app's own public base URL, for building redirect_uri
SHOPIFY_SCOPES=             # the "required now" comma-separated scope list from §4
SHOPIFY_API_VERSION=        # pinned version string, e.g. "2026-07" — bump deliberately, not implicitly
```

`.env.example` should gain a new clearly-labeled section for these (mirroring the existing Supabase
section's structure/tone) when 2B.2 actually implements the flow — not added in this
planning-only phase.

---

## 9. Blockers to resolve before implementation (2B.2)

1. **A real Shopify Partner account + public app registration must exist** before any code can be
   meaningfully tested end-to-end — this is an external, human action, not something this session
   can create.
2. **Empty-scope behavior is unconfirmed.** §4 flags that whether Shopify's current authorize
   endpoint accepts a literal empty `scope` param (for a "just identify the shop, no data access
   yet" connection) needs to be confirmed against the live Dev Dashboard/API at implementation
   time, not assumed from docs alone — if it's rejected, `read_products` becomes the de facto
   minimum "required now" scope.
3. **Exact scope names for collections/navigation/pages (Phase 2D/2E) need re-verification at
   those phases' implementation time** — Shopify's scope naming has shifted across API versions
   historically (§4 flags `write_publications` and page-content scopes as best-current-understanding,
   not confirmed against a live scope reference). Not a blocker for 2B.1/2B.2 (which need no such
   scopes), but should not be treated as settled when 2D/2E begin.
4. **Vault/pgsodium setup is a new Supabase-project-level capability** not yet used anywhere in
   StorePilot — needs its own small verification pass (confirm it's enabled on the project, confirm
   the encrypt/decrypt call shape) before `sp_shopify_credentials` can be implemented as designed,
   separate from writing the OAuth flow itself.
5. **`src/proxy.ts` matcher change is a real code change**, even though this plan is architecture-only
   — flagging it here so 2B.2 doesn't discover it mid-implementation: the callback/webhook routes
   must be added to the Supabase-session-redirect exclusion list, and that change should be scoped
   and reviewed on its own, since `src/proxy.ts` is currently a Phase 2A file with no test coverage
   of its own beyond manual verification.

---

## 10. Quality gate

Run without any code changes (this phase produced documentation only):

- `npm run check:css` — **pass** (55 source files scanned, no malformed pattern).
- `npm run lint` — **pass**, no errors/warnings.
- `npx tsc --noEmit` — **pass**, no errors.
- `npm run build` — **pass**, 7 routes generated, Proxy/middleware active, no warnings.

---

## Explicitly NOT done in this phase
No OAuth code written. No Supabase migrations created or applied. No Shopify products, catalog
parsing, or theme upload implemented. Phase 2A's migrations and RLS policies are unmodified — this
document proposes new, additive objects only. Nothing committed, staged, pushed, or tagged.
