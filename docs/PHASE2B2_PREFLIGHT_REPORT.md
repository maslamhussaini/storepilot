# StorePilot Phase 2B.2 Pre-Flight — Shopify + Supabase Security Verification

**Status: verification/design only.** No OAuth code, no migrations, no Vault secrets, no extensions
enabled, no RLS changes, no commits. Baseline: Phase 2A frozen at `a8b34fd`; builds on
`docs/PHASE2B1_SHOPIFY_AUTH_PLAN.md`, refines two designs it left open, and corrects one internal
inconsistency found while working through the "keep connection history" requirement (noted inline
in §6).

---

## 1. Verified Shopify 2026 token lifecycle

Re-verified directly against `shopify.dev`, not carried over from memory.

- **Expiring-offline-token deadline**: sources disagree on the exact date and this needed to be
  reported honestly rather than picked arbitrarily. One search result stated "April 1, 2026" for
  *new* public apps; the authoritative `offline-access-tokens.md` page itself states **"Public
  apps must use expiring offline access tokens for GraphQL Admin API requests by January 1,
  2027,"** and explicitly scopes this to public apps only — custom/merchant-created apps are
  exempt. Since StorePilot is a new public app being built now, in September 2026, the practical
  answer is the same either way: **implement expiring tokens from the start**, and treat the exact
  deadline as needing one final confirmation against the live Partner Dashboard/docs at 2B.3
  implementation time rather than as settled today.
- **Request parameter**: `expiring` in the token-exchange request body — `"1"` for an expiring
  offline token, `"0"` (default) for the old non-expiring style. Confirms Phase 2B.1.
- **Token response fields**: `access_token`, `refresh_token`, `expires_in`, `refresh_token_expires_in`.
- **Access token expiry**: `expires_in = 3600` (1 hour).
- **Refresh token expiry**: 90 days from issuance (`7776000` seconds), **but** — important nuance
  — "the previous refresh token remains usable until your app uses the newer one, a new token is
  acquired, 30 days pass since first use, or the original 90-day expiry occurs, whichever comes
  first." This means a refresh token's *effective* lifetime can be as short as 30 days after its
  first use, not always the full 90 — the refresh scheduler must account for the shorter window,
  not just the nominal 90-day figure.
- **Rotation behavior**: every refresh call returns **both** a new access token and a new refresh
  token — this is full rotation, not access-token-only renewal. The storage design (§4/§6) must
  overwrite both values atomically on every refresh, never just the access token.
- **Refresh request format**: uses the stored `refresh_token` value; exact request shape (endpoint,
  body fields) was not fully resolved from the fetched excerpt — **flagged for confirmation against
  the live docs at 2B.3 implementation time**, not assumed here.
- **State/HMAC/shop-domain/uninstall/compliance-webhooks/API-version**: unchanged from Phase 2B.1's
  findings (authorization code grant, `state` nonce, HMAC-SHA256 over sorted query params with
  constant-time comparison, anchored `myshopify.com` regex, `app/uninstalled` webhook,
  App-Store-conditional GDPR webhooks, 2026-07 current stable API version) — re-affirmed, not
  re-litigated here.

## 2. Empty-scope verdict

**LIVE TEST REQUIRED.** The scopes reference page states "All apps need to request access to
specific store data during the app authorization process," which leans toward scopes being
expected/required, but this is not an explicit, unambiguous statement that a literal empty `scope`
parameter is rejected. No official page fetched in this pass or the Phase 2B.1 pass states the
empty-scope behavior definitively either way. **Per instruction, `read_products` is NOT being
added as a default/workaround.** This must be resolved by an actual authorize-URL test against a
real Partner Dashboard app in Phase 2B.3, before the "required now" scope list in
`SHOPIFY_SCOPES` (§9) is finalized.

## 3. Vault availability — verified via read-only Supabase MCP inspection

Inspected project `nchxfngytvchlnlogeuy` directly. No extensions enabled, no secrets created, no
SQL changes made.

- **`supabase_vault` extension**: already installed (`installed_version: "0.3.1"`, schema `vault`)
  — **no `CREATE EXTENSION` needed**, it ships enabled on this Supabase Cloud project already.
- **`pgsodium`**: present in the extension catalog but **not installed**
  (`installed_version: null`) — confirms the task's instruction not to design around raw pgsodium;
  Vault is the correct, already-available layer and nothing needs enabling to use it.
- **Vault's actual surface** (read directly from `information_schema`/`pg_proc`, not assumed):
  - `vault.secrets` (base table): `id uuid`, `name text`, `description text NOT NULL`,
    `secret text NOT NULL` (ciphertext), `key_id uuid`, `nonce bytea`, `created_at`, `updated_at`.
  - `vault.decrypted_secrets` (view): same shape, decrypts `secret` transparently for permitted
    callers.
  - `vault.create_secret(new_secret, new_name, new_description, new_key_id)` and
    `vault.update_secret(secret_id, new_secret, new_name, new_description, new_key_id)` — the
    two functions StorePilot would actually call.
- **Grants — the single most important finding of this pre-flight**: queried
  `information_schema.role_table_grants` for the `vault` schema directly. **Only `postgres` and
  `service_role` hold any privilege (SELECT/DELETE/etc.) on `vault.secrets` or
  `vault.decrypted_secrets`. Neither `anon` nor `authenticated` has any grant at all.** This is a
  *stronger* guarantee than the RLS-based "zero policies" pattern Phase 2B.1 proposed for a
  hand-rolled `sp_shopify_credentials` table: it's enforced by Postgres's fundamental GRANT system,
  not by the absence of an RLS policy, so there is no scenario (RLS bug, policy typo, RLS
  accidentally disabled) that could expose it to a normal client role. This directly resolves §4's
  question about server-side privilege (see below).
- **Usability for per-store Shopify tokens**: yes, directly usable as designed. No extension/setup
  action is required before Phase 2B.3 can start using it.

## 4. Final credential-storage architecture (resolves the A vs. B comparison)

**Recommendation: Design A — `sp_shopify_connections` + Vault secrets referenced by UUID. No
separate `sp_shopify_credentials` table.**

Phase 2B.1 proposed Design B (a second hand-rolled table with RLS-enabled-zero-policies) as a
defense-in-depth measure on top of Vault. Having now confirmed Vault's own GRANT-level isolation
(§3) is *already* at least as strong as what a second table would add, Design B is exactly the
"unnecessary duplicate security layer" this task asked to avoid — a second table would duplicate
the "server-only, no client grant" property Vault already provides natively, add a second place
for the token to ever exist in Postgres, and add operational surface (two tables to keep in sync
on rotation/delete) for no additional guarantee.

**Final shape:**
- `sp_shopify_connections.vault_secret_id uuid` — one column, pointing at a single Vault secret per
  connection.
- The Vault secret's `secret` value is a **small JSON blob**: `{"access_token": "...",
  "refresh_token": "...", "expires_at": "2026-09-18T12:00:00Z"}` — one JSON payload, not two
  separate Vault rows for access/refresh. This makes rotation **atomic by construction**: a single
  `vault.update_secret(...)` call replaces all three fields together, so there is no window where
  a partially-updated pair (new access token, stale refresh token, or vice versa) could be read by
  a concurrent request — directly satisfies the "rotate atomically" requirement in §3 of the task
  and matches Shopify's own full-rotation behavior (§1: every refresh returns both tokens changed
  together).
- Disconnect/uninstall deletes the `vault.secrets` row (via `DELETE FROM vault.secrets WHERE id =
  ...` inside the same SECURITY DEFINER function that checked ownership) — the credential ceases
  to exist entirely, not merely "unlinked."
- Token values never enter a normal client-facing `SELECT` because `sp_shopify_connections` itself
  never contains the token — only an opaque `vault_secret_id` — and that UUID grants nothing on its
  own (it's not a capability token; reading `vault.secrets`/`vault.decrypted_secrets` by that id
  still requires the `service_role`/`postgres`-level grant regime confirmed in §3).
- Logging: every server code path that touches a token (set/get/refresh/delete) must log only
  `connection_id`/`shop_domain`/outcome, never the token value or the raw Vault secret payload —
  a normal logging-discipline requirement, not a schema feature, called out explicitly in §10 as a
  concrete engineering rule for 2B.3.

## 5. Server privilege model

Determined by working through **who is calling, with what identity, in each of the four
operations** — this is where the design forked into two genuinely different cases, not one uniform
answer.

### Case 1 — operations that happen inside a real StorePilot user session
*Store token pair* (after OAuth callback), *retrieve current access token* (before an Admin API
call), *refresh tokens* (on-demand, when a StorePilot user action triggers an Admin API call and
the stored token is near/past expiry), *rotate credentials*, *user-initiated disconnect*. In every
one of these, the Next.js server code runs inside a Route Handler or Server Action that has already
established a real Supabase user session (via `requireUser()`, per the existing Phase 2A pattern —
the OAuth callback specifically reconstructs this from StorePilot's own signed state cookie, which
is only ever set after a successful `requireUser()` call in `/api/shopify/authorize`, and that
session's own first-party cookies survive the round-trip through Shopify's redirect since they're
scoped to StorePilot's own origin, not affected by the third-party hop).

For this case: **four `SECURITY DEFINER` functions in the `public` schema**, callable via the
*existing* `createSupabaseServerClient()` (the user's own JWT, exactly like every Phase 2A query) —
**no new secret, no service-role key, needed for any of these five operations.** Each function:
```
set search_path = ''                          -- pinned, matches sp_set_updated_at() precedent
-- fully qualifies every reference: public.sp_shopify_connections, vault.secrets, auth.uid()
-- re-verifies (select 1 from public.sp_projects p join public.sp_shopify_connections c
--              on c.project_id = p.id where c.id = <connection_id> and p.user_id = auth.uid())
--   before touching vault.* at all — the function does NOT trust that PostgREST/RLS already
--   filtered anything, because SECURITY DEFINER functions run with the DEFINING role's
--   privileges and therefore bypass RLS on every table they touch, including
--   sp_shopify_connections itself. The ownership check must be explicit and first.
revoke execute on function ... from public;
revoke execute on function ... from anon;
grant execute on function ... to authenticated;   -- the justified case: this IS how the
                                                    -- legitimate owner's own server action
                                                    -- reaches it
```
Why `SECURITY DEFINER` is required here at all (not just an ordinary function): an ordinary
`SECURITY INVOKER` function called by the `authenticated` role would run with *that role's*
privileges when it reaches into `vault.*` — and `authenticated` has no grant there (§3). Only a
function *defined* by a role that does have the grant (effectively `postgres`, the migration
owner) and marked `SECURITY DEFINER` can bridge "authenticated user, ownership-checked" into
"read/write Vault."

### Case 2 — the Shopify-initiated `app/uninstalled` webhook
This is the one operation with **no StorePilot user session at all** — Shopify's servers POST
directly to our webhook endpoint, authenticated only by the request's `X-Shopify-Hmac-Sha256`
header (verified in our own Next.js code, before any database call), never by a Supabase JWT.
`auth.uid()` is meaningless in this context; there is no "caller" to check ownership against in the
same way. This is exactly the **"explicit justified requirement"** the task's §4 anticipated for
granting broader access.

**Two structurally sound options**, presented rather than silently chosen, since this is a genuine
architecture decision:
- **(Recommended) A narrowly-scoped `SUPABASE_SERVICE_ROLE_KEY`, used exclusively inside one
  server-only module** (e.g. `src/lib/shopify/webhookAdmin.ts`, carrying `import "server-only"`,
  imported by nothing except `src/app/api/shopify/webhooks/uninstalled/route.ts`). This reuses the
  already-documented placeholder in `.env.example` ("future server-only admin tooling... If you
  ever do use it, import it exclusively in a module that carries `import 'server-only'`" — Phase
  2A anticipated exactly this need without naming it). The webhook handler looks up the connection
  by `shop_domain` (already HMAC-verified before this point) using the service-role client — which
  bypasses RLS entirely, which is *correct* here because there is no user identity to scope RLS to
  in the first place — and calls a small internal `sp_shopify_disconnect_by_shop(shop_domain)`
  function or does the update/delete directly via the service-role client (a SECURITY DEFINER
  wrapper is less necessary here since the service-role key already bypasses RLS by design;
  wrapping it in a function mainly helps keep the "delete the vault secret too" logic in one
  place). This is the only place in the entire application, across all of Phase 1/2A/2B, that would
  use the service-role key.
- **(Alternative, not recommended)** A direct Postgres connection via `SUPABASE_DB_URL` for this
  one route instead of the Supabase JS client — conceptually cleaner in isolation ("a webhook
  credential" vs. "the master RLS-bypass key") but adds a second connection mechanism
  (`pg`/`postgres.js` as a new dependency) for a single call site, with no material security
  improvement over the first option as long as the service-role usage stays confined to that one
  file. Recommendation: don't add this complexity unless a future need for direct SQL elsewhere
  makes it worth introducing generally.

**Answer to "does StorePilot actually require a server-side Supabase secret/service-role key":**
**Yes, but only for this one, specific, already-anticipated code path — not for the OAuth flow
itself, not for token storage/retrieval/refresh, not for user-initiated disconnect.** It is not
being added "for convenience"; it is required because that operation genuinely has no user session
to derive an ownership check from.

## 6. Final `sp_shopify_connections` design

```
id                uuid primary key default gen_random_uuid()
project_id        uuid not null references public.sp_projects(id) on delete cascade
user_id           uuid not null references auth.users(id) on delete cascade
shop_domain       text not null                          -- validated ^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$
shop_id           bigint                                  -- Shopify's numeric shop id
shop_name         text
vault_secret_id   uuid                                    -- points at vault.secrets; null once disconnected
scopes            text not null default ''
status            text not null default 'connected'
                    check (status in ('connected', 'disconnected', 'revoked'))
installed_at      timestamptz not null default now()
disconnected_at   timestamptz
created_at        timestamptz not null default now()
updated_at        timestamptz not null default now()      -- via the existing sp_set_updated_at() trigger
```

### A correction to Phase 2B.1, caught in this pass
2B.1 proposed a plain `unique(project_id)` constraint *and*, separately, said disconnected rows
should be **kept** (not deleted) for connection history. **Those two requirements directly
conflict**: a plain unique constraint would block ever inserting a second row for the same
project once the first is disconnected, forcing either "no history" (contradicting the stated
disconnect semantics) or "delete-then-reinsert on reconnect" (losing the history the design
explicitly wanted). Fixed here with **partial unique indexes** instead of table-wide unique
constraints:
```
create unique index sp_shopify_connections_one_active_per_project
  on public.sp_shopify_connections (project_id) where status = 'connected';

create unique index sp_shopify_connections_one_active_per_shop
  on public.sp_shopify_connections (shop_domain) where status = 'connected';
```
This gives exactly the intended semantics:
- **One project → one active Shopify connection at a time** (the same rule 2B.1 intended), while
  still allowing multiple historical `disconnected`/`revoked` rows per project.
- **One shop → one active StorePilot project connection at a time** — newly decided in this pass,
  answering a question 2B.1 left open ("whether the same Shopify shop can belong to multiple
  StorePilot projects"). **No**, not simultaneously: once Phase 2C/2E start writing real products
  to a connected shop, two StorePilot projects both actively "owning" the same live store would
  create ambiguous, conflicting writes. A merchant experimenting with a shop across multiple draft
  projects is still possible over time (connect to project A, disconnect, connect the same shop to
  project B later) — only *concurrent* dual-ownership is blocked, and it's blocked at the database
  level (a constraint), not merely by application-layer convention.

### Reconnect semantics
A fresh, successful OAuth round-trip for a project that already has an active connection: within
one transaction, mark the existing active row `disconnected` (`disconnected_at = now()`), delete
its `vault.secrets` row, then insert the new row with a new `vault_secret_id`. Never update the old
row's `shop_domain` in place — a "reconnect to a different shop" is modeled as
disconnect-old + connect-new, keeping the history table honest about what was actually connected
when.

### Disconnected/uninstalled semantics
- **User-initiated disconnect**: `status = 'disconnected'`, `disconnected_at = now()`,
  `vault_secret_id = null` after deleting the Vault row, best-effort Shopify-side token revocation
  attempted (not required to succeed for our own state to be correct).
- **Shopify-initiated uninstall** (webhook): identical end state, reached via the Case-2 privilege
  path in §5, looked up by `shop_domain` rather than by an authenticated user's `connection_id`.
- **`revoked`** status is distinct from `disconnected`: reserved for "we tried to use the token and
  Shopify told us it's no longer valid" (e.g. a `401`/`invalid_token` from an Admin API call outside
  the normal uninstall-webhook path) — surfaces differently in the UI ("reconnect needed" vs.
  "not connected"), per 2B.1's error-handling table.

### RLS (unchanged in spirit from 2B.1, restated precisely for this final shape)
4 policies (select/insert/update/delete) on `sp_shopify_connections`, each requiring
`user_id = (select auth.uid())` **and** `exists (select 1 from public.sp_projects p where p.id =
sp_shopify_connections.project_id and p.user_id = (select auth.uid()))` — identical structural
pattern to `sp_business_profiles`'s policies (Phase 2A). RLS enabled and forced. No policy for
`anon` at all (fails closed, same as every Phase 2A table). This table is client-readable metadata
only — it contains no token, so client SELECT access is intentional and safe, unlike the abandoned
`sp_shopify_credentials` design.

**No changes to any Phase 2A migration, table, or policy.** This is purely additive.

## 7. Proxy/callback/webhook design

Inspected `src/proxy.ts` directly (current file, not re-derived from memory).

Current behavior already relevant: `isProtectedPath()` only matches `pathname === "/"` and
`pathname` under `/projects` (`PROTECTED_PREFIXES = ["/projects"]`). Since none of the three new
routes fall under `/projects`, **`/api/shopify/callback` and `/api/shopify/webhooks/*` already pass
through `proxy()` untouched today, with zero code change required** — they are not in
`PROTECTED_PREFIXES`, so the unauthenticated-redirect branch never fires for them, and they are not
in `AUTH_ROUTES` either, so the authenticated-redirect-away-from-login branch never fires for them.
The proxy's session-refresh logic (`supabase.auth.getUser()`) still runs on every matched request,
including these — harmless for a webhook POST with no Supabase session cookie present (the
Supabase server client's cookie handlers simply have nothing to read or refresh in that case) and
correctly still refreshes the user's own session cookie on the callback request, which matters
because that request needs the user's existing session intact to know who's completing the OAuth
flow.

**One minimal, recommended addition**: add `/api/shopify/authorize` to `PROTECTED_PREFIXES` (or a
new small `AUTHORIZE_PREFIXES` list, same mechanism). This is not required for security —
`requireUser()` inside the Route Handler is the actual, mandatory check, exactly matching the
existing Phase 2A philosophy stated in `proxy.ts`'s own comments ("Always verify authentication...
rather than relying on Proxy alone") — but it's a cheap, consistent UX/defense-in-depth win: an
unauthenticated hit on `/api/shopify/authorize` gets redirected to `/login` before the handler even
runs, instead of the handler running partway and then rejecting.

**Explicitly do NOT add** `/api/shopify/callback` or `/api/shopify/webhooks/*` to
`PROTECTED_PREFIXES` — doing so would be actively wrong: the callback's authority comes from
StorePilot's own signed state cookie + Shopify's HMAC, not from requiring an *independently*
re-authenticated session at that exact moment (the user is mid-redirect-flow, not making a fresh
authenticated request), and the webhook has no user session at all by design (§5, Case 2) — forcing
either through the login-redirect branch would break the flow outright, not just be redundant.

**Summary: one file, `src/proxy.ts`, one array addition. No weakening of any existing protection.**
`/` and `/projects/*` remain exactly as protected as they are today.

## 8. Environment-variable contract (names only, no values)

| Variable | Classification | Purpose |
|---|---|---|
| `SHOPIFY_CLIENT_ID` | SERVER-ONLY | OAuth `client_id`; used to build the authorize URL and in token exchange. Not `NEXT_PUBLIC_*` — even though it's technically less sensitive than the secret, the authorize URL is always built server-side (§7's Route Handler), so there is no reason for the browser to ever hold it directly. |
| `SHOPIFY_CLIENT_SECRET` | SERVER-ONLY | Used only for HMAC verification and token exchange. Never logged, never returned in any response. |
| `SHOPIFY_APP_URL` | SERVER-ONLY | StorePilot's own public base URL, used to construct `redirect_uri` server-side. No client-side use identified. |
| `SHOPIFY_API_VERSION` | SERVER-ONLY | Pinned Admin API version string (e.g. a `2026-07`-shaped value) for every Admin API call. Bumped deliberately, not implicitly. |
| `SHOPIFY_SCOPES` | SERVER-ONLY | The "required now" scope list from Phase 2B.1 §4, **pending the §2 live-scope-test resolution** before its final value is settled — the *variable name* is fixed now, its value is not. |
| `SUPABASE_SERVICE_ROLE_KEY` | SERVER-ONLY | Already present as a placeholder in `.env.example` since Phase 2A (documented as unused until a genuine need arose). **This pre-flight is that genuine need**: used exclusively inside the `app/uninstalled` webhook handler module (§5, Case 2) — nowhere else, in this phase or any prior one. |

No new `NEXT_PUBLIC_*` variables are needed anywhere in this design — every piece of Shopify
configuration is consumed exclusively by server-side code (Route Handlers, SECURITY DEFINER
functions, the one webhook module), consistent with the security rules given for this task.

## 9. Shopify Dev Dashboard setup checklist

### LOCAL DEVELOPMENT
1. A Shopify Partner organization (personal or existing) — external action, cannot be automated.
2. Create a new app in the Partner Dashboard as **Public app** (not "Custom app" — StorePilot is
   multi-merchant; per §1, custom apps are also exempt from the expiring-token requirement, which
   is a meaningful signal that "custom" is the wrong distribution type for our actual product).
3. Register an **App URL** and **Allowed redirection URL(s)** — for local development this needs
   an HTTPS-reachable URL, since Shopify's OAuth redirect requires HTTPS (§1/2B.1); `localhost`
   alone will not satisfy this for our external-redirect architecture (unlike an embedded-app CLI
   tunnel workflow, which doesn't apply here). A tunneling tool (e.g. ngrok, or Shopify CLI's own
   tunnel feature used purely for the HTTPS front door, not for embedded-app tooling) will be
   needed to expose the local Next.js dev server over HTTPS for this one step.
4. Note the issued **Client ID** and **Client Secret** — enter these directly into `.env.local`
   when that file is worked on in 2B.3; never paste them into chat, code, or documentation.
5. Set up a **development store** (Partner Dashboard → Stores → Add store → Development store) to
   perform the actual OAuth click-through test against.
6. Decide and record the **initial `SHOPIFY_SCOPES` value** — blocked on §2's live-scope test,
   which itself requires this same Partner Dashboard app to already exist, so this is naturally the
   first real test performed once the app is created.
7. Configure the `app/uninstalled` **webhook subscription** pointing at the local tunnel's
   `/api/shopify/webhooks/uninstalled` URL, for testing the uninstall path locally.

### PRODUCTION
1. A second **Allowed redirection URL** entry (or update the existing one) pointing at
   StorePilot's real production domain's `/api/shopify/callback`.
2. Confirm `SHOPIFY_APP_URL` in the production environment matches the production domain exactly
   (byte-for-byte with what's registered, including trailing-slash presence/absence — called out
   in 2B.1 as an exact-match requirement).
3. Re-point the `app/uninstalled` webhook subscription (and any GDPR compliance webhooks, if/when
   App Store distribution is pursued) at the production URLs.
4. Before requesting App Store review (if that path is chosen later): revisit §1's GDPR compliance
   webhook requirement as mandatory at that point, not merely optional.
5. Rotate/confirm production `SHOPIFY_CLIENT_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` are set only
   in the production environment's secret store, never in a committed file — same discipline
   already established for the Supabase keys in Phase 2A/2A.1.

## 10. Security threat review

| Threat | Mitigation |
|---|---|
| Forged shop domain | Anchored regex validation (`^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$`) applied before the domain is ever used in a URL, a query, or persisted — both at authorize-request time (user input) and at callback time (Shopify's own `shop` param, not implicitly trusted just because it came from Shopify's redirect). |
| OAuth CSRF/state attack | Server-generated random nonce (`crypto.randomBytes`, not `Math.random()`) stored in a signed, httpOnly, short-lived cookie; callback compares against it and rejects on any mismatch, including an *absent* cookie (e.g. a forged callback hit directly, never having gone through our own authorize step). |
| Callback replay | The state cookie is single-use and short-lived (§ "expired state is rejected" test from 2B.1); once consumed by a successful callback it should be cleared, so replaying the same callback URL a second time fails the state check on the second attempt. |
| HMAC tampering | Full HMAC-SHA256 verification over the sorted, reassembled query string using the client secret, with **constant-time comparison** (`crypto.timingSafeEqual`) — never a naive `===`, which is a timing side-channel. Applies to both the OAuth callback's query-param HMAC and the webhook's separate `X-Shopify-Hmac-Sha256` body HMAC (different mechanisms, not interchangeable — flagged in 2B.1, restated here as a threat-model line item). |
| Cross-tenant project ID substitution | Every SECURITY DEFINER function independently re-derives ownership from `auth.uid()` joined through `sp_projects`, never trusting a client-supplied `project_id`/`connection_id` at face value — same pattern proven correct by Phase 2A's 24/24 RLS assertions, extended here to the new functions rather than assumed to transfer automatically. |
| Token leakage to browser | Tokens exist only inside `vault.secrets`, reachable only via SECURITY DEFINER functions that return, at most, an access token + expiry to a verified owner for the single purpose of making one Admin API call — never the refresh token, never a bulk "give me the credential row." No Shopify token value is ever part of any Server Component prop, client bundle, or response body reachable from client JS. |
| Token leakage to logs | Explicit engineering rule (§4): every code path touching a token logs only `connection_id`/`shop_domain`/outcome. This is a discipline to enforce in code review at 2B.3, not something the architecture alone guarantees — called out so it isn't silently assumed. |
| Token leakage to Supabase client queries | Structurally impossible for the *normal* authenticated/anon PostgREST path: `vault.secrets`/`vault.decrypted_secrets` have zero grants for those roles (§3, verified by inspection, not assumed) — a client query against those tables fails with a permission error, not merely an RLS-empty result. `sp_shopify_connections` itself never contains a token value to leak in the first place. |
| Unauthorized disconnect | The disconnect function requires the same ownership check as every other Case-1 operation (§5) — a user can only disconnect a connection whose `project_id` resolves to their own `auth.uid()` via `sp_projects`. |
| Forged uninstall webhook | The webhook's HMAC (body-based, `X-Shopify-Hmac-Sha256`) is verified before any database call — an unsigned or incorrectly-signed POST to the webhook URL is rejected before it can reach the Case-2 privileged code path at all. |
| Refresh-token race | The "store both tokens as one atomic JSON blob via a single `vault.update_secret` call" design (§4) removes the specific race of "access token updated, refresh token not yet updated (or vice versa) being read by a concurrent request" — there is no intermediate state where only one half is updated. A *separate*, still-open concern for 2B.3 to design carefully: two concurrent requests both deciding "this token needs refreshing" and both calling Shopify's refresh endpoint simultaneously — Shopify's own rotation semantics (§1: "previous refresh token remains usable until the newer one is used") mean this likely self-resolves without corruption, but the exact concurrent-refresh behavior should be an explicit test case in 2B.3, not assumed safe by inference alone. |
| Duplicate Shopify installation | Enforced at the database level via the two partial unique indexes in §6 (one active connection per project, one active connection per shop) — not merely an application-layer convention that could be bypassed by a bug or a race condition in the app code. |

## 11. Remaining blockers requiring manual action

1. **Shopify Partner account + public app registration** — external, human action; nothing in this
   session can create it.
2. **§2's empty-scope live test** — needs the app from #1 to exist first; cannot be resolved from
   documentation alone, and this pre-flight deliberately did not guess.
3. **Exact refresh-token request shape** (§1) — needs confirmation against the live docs (or a live
   test) at 2B.3 implementation time; not fully resolved by the fetched documentation excerpt.
4. **Development store creation** (Dev Dashboard checklist §9) — needed before any real
   click-through test, same as Phase 2A needed a live Supabase project before its real-browser
   acceptance test could run.
5. **A decision on the service-role-key vs. direct-Postgres-connection question in §5, Case 2** —
   this document recommends the service-role-key path and explains why, but it's a real design
   choice worth confirming before 2B.3 writes that specific webhook module.
6. **HTTPS tunnel tooling choice for local development** (§9) — not selected here; any standard
   HTTPS tunnel works, but picking one is a small remaining decision before local OAuth testing can
   start.

## 12. Quality-gate results

No code was changed in this phase (verification/design only) — gates re-run to confirm the
baseline remains exactly as Phase 2B.1 left it:

- `npm run check:css` — **pass**, 56 source files scanned, no malformed pattern.
- `npm run lint` — **pass**, no errors/warnings.
- `npx tsc --noEmit` — **pass**, no errors.
- `npm run build` — **pass**, 7 routes generated, Proxy/middleware active, no warnings.

## 13. Exact proposed scope of Phase 2B.3

Implementation phase, gated on the manual actions in §11 (at minimum #1 and #4 — the Partner app
and dev store — must exist before any of this can be tested, though the code itself can be written
against the design in §4–§9 without them):

1. Two new Supabase migrations (still not applied in this phase): `sp_shopify_connections` table
   with the exact shape in §6 (columns, partial unique indexes, RLS policies), and the four
   Case-1 `SECURITY DEFINER` functions from §5 (set/get/refresh/delete-by-owner) plus their
   `REVOKE`/`GRANT` statements.
2. `src/app/api/shopify/authorize/route.ts`, `src/app/api/shopify/callback/route.ts` — real
   implementation of the flow designed in Phase 2B.1 §5, using the finalized token/Vault design
   from this document.
3. `src/app/api/shopify/webhooks/uninstalled/route.ts` + the narrowly-scoped
   `src/lib/shopify/webhookAdmin.ts` (service-role client, `import "server-only"`, used nowhere
   else) from §5, Case 2.
4. Disconnect Server Action, wired into the (still to be redesigned in a later phase) Connect step
   UI — replacing `connectDemoStore()`.
5. `src/proxy.ts`: the single `PROTECTED_PREFIXES` addition from §7.
6. `.env.example` additions for the five variables in §8 (names/comments only, matching the
   existing section's tone — no real values).
7. The full test suite from Phase 2B.1 §6, now implementable against real code: unit tests
   (normalization/state/HMAC/URL-building), integration tests for every rejection path, the
   `rls_security_tests.sql` extension (now also proving the Vault-grant boundary, not just RLS, per
   §3/§10 of this document), the token-non-exposure log-grep test, and — once the Partner app +ev
   store exist — the real click-through acceptance test.
8. **Explicitly still out of scope for 2B.3**: no product/catalog writes, no theme access, no
   billing — this phase connects and authenticates only, exactly as Phase 2B.1 scoped it.

---

*Phase 2B.2 pre-flight complete. No OAuth implemented, no migrations applied, no Vault secrets
created, no extensions enabled, no RLS changed, nothing committed, staged, pushed, or tagged.*
