# StorePilot Phase 2B.3A — Persistence Foundation Report

## A. Objective & Scope

Phase 2B.3A establishes the persistent Shopify connection **security
foundation**: schema, Vault integration, SECURITY DEFINER functions, RLS,
database-level secret bans, tests, and documentation.

Explicitly **out of scope** (deferred to Phase 2B.3B):

- No OAuth callback wiring (`src/app/api/shopify/callback/route.ts` untouched)
- No persistence of the Phase 2B.2 spike token
- No scope changes (zero-scope install unchanged)
- No wizard UI changes, no token refresh, no webhooks

## B. Baseline & Frozen Phase 2B.2

- Baseline commit: `59ac51e4607a2470db9c37e0e6590866770dca89`
- Phase 2B.2 was verified frozen; integration needs were checked and the
  callback route requires **no changes** for 2B.3A.
- The initial 2B.3A work was committed as `7394da6` ("feat: add Shopify
  connection persistence foundation") by a prior session **before it had ever
  been executed against a database**. That commit is already pushed to
  `origin/main`; force push is prohibited, so all corrections in this report
  ship as a normal follow-up commit on top of it.
- Supabase MCP note: the original MCP config pointed at project
  `fdpevqnnfwqixllrpdqo` (an unrelated FBR project) and was **never** used
  for any write. The MCP was later re-pointed to `nchxfngytvchlnlogeuy`
  (verified via `get_project_url` before any write), which unblocked cloud
  application (see §Q).

## C. Plan Corrections & Defects Found in the Original Draft

The draft plan and the original `7394da6` SQL contained defects that were
found by executing the work locally (none of it had ever run anywhere):

1. **Illegal subquery CHECK** — `7394da6` used
   `CHECK (exists (select ... from sp_projects ...))`. PostgreSQL rejects this
   with `cannot use subquery in check constraint` (proven by executing the
   migration on PostgreSQL 17). The migration had therefore never applied.
   **Fix**: ownership-enforcement trigger
   `sp_shopify_connections_enforce_ownership()` (BEFORE INSERT/UPDATE, fails
   closed for non-RLS-bypassing writers).
2. **Missing EXECUTE revocations** — all four functions inherited PostgreSQL's
   default `EXECUTE ... TO PUBLIC`, so `anon` and `authenticated` could have
   called `store_connection_tokens`, `get_connection_tokens` and
   `revoke_connection_tokens` via PostgREST RPC. **Fix**: explicit
   `REVOKE ... FROM PUBLIC, anon, authenticated` on every function, then
   minimal grants; proven by test scenario F.
3. **Supabase default function privileges** — discovered while verifying (2):
   Supabase's default privileges also auto-grant `service_role` EXECUTE on
   new public-schema functions. This is harmless (trusted server role) and is
   now explicitly granted and documented instead of left implicit.
4. **`auth.uid()` ownership check in `get_connection_tokens`** — `auth.uid()`
   is NULL in the trusted server context, so the function would have returned
   zero rows for its only legitimate caller. **Fix**: the check was removed;
   the EXECUTE grant is the boundary.
5. **`decrypted_secret` is `text`, not `jsonb`** — `vs.decrypted_secret->>...`
   in the original getter would fail at runtime (`supabase_vault` 0.3.1
   returns `text`). **Fix**: `vs.decrypted_secret::jsonb ->> 'access_token'`.
6. **`vault.create_secret` argument order** — signature is
   `(new_secret, new_name, new_description, new_key_id)`; the first
   implementation passed name first, silently storing the name as the
   encrypted secret. Caught by the decrypt round-trip test (G.3), fixed.
7. **Vault payload whitelist** — original payload stored the entire OAuth
   response. Now only `access_token` + `refresh_token` go to Vault; scopes
   and expiry timestamps are non-secret columns.
8. **Token getter return shape** — `expires_in` is no longer stored in Vault,
   so `get_connection_tokens` now returns `shop_domain`, `access_token`,
   `refresh_token`, `access_token_expires_at`, `refresh_token_expires_at`.
9. **Secret-less events now DB-enforced** — added a CHECK constraint on
   event `metadata` (see §N) instead of relying on server-layer discipline.
10. **`reconnected` vs `installed`** — re-authentication and reconnection now
    log `reconnected`; only the first-ever connection for a project logs
    `installed`. Shop domains are lowercased/trimmed before persisting.
11. **Test suite restructure** — the original suite had `authenticated`
    calling `store_connection_tokens` directly (contradicting the server-only
    design) and assertions that could not pass (F.2–F.4, G.2). Setup now runs
    through the `service_role` path; scenarios A–M cover the full contract.

## D. Final Schema: `sp_shopify_connections`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `project_id` | `uuid` | NOT NULL, FK → `sp_projects(id)` ON DELETE CASCADE |
| `user_id` | `uuid` | NOT NULL, FK → `auth.users(id)` ON DELETE CASCADE |
| `shop_domain` | `text` | NOT NULL, stored lowercased + trimmed |
| `status` | `text` | NOT NULL, `connected` / `reauth_required` / `disconnected` / `uninstalled` |
| `granted_scopes` | `text[]` | nullable; zero-scope installs → `{}` |
| `vault_secret_id` | `uuid` | nullable; Vault secret UUID, never token strings |
| `access_token_expires_at` | `timestamptz` | nullable, derived from `expires_in` |
| `refresh_token_expires_at` | `timestamptz` | nullable, derived from `refresh_token_expires_in` |
| `installed_at` | `timestamptz` | nullable |
| `disconnected_at` | `timestamptz` | nullable |
| `last_verified_at` | `timestamptz` | nullable |
| `created_at` / `updated_at` | `timestamptz` | `default now()`, `updated_at` trigger-stamped |

Constraints:

- **CHECK**: `status IN ('connected','reauth_required','disconnected','uninstalled')`
- **Ownership**: NOT a CHECK (subqueries are illegal in CHECK — §C.1).
  Enforced by trigger `sp_shopify_connections_enforce_ownership`: re-derives
  the owner from `sp_projects.user_id` on every INSERT/UPDATE and raises on
  mismatch or missing project.
- Triggers: `sp_set_updated_at` (shared), ownership trigger.

## E. Final Schema: `sp_shopify_connection_events`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `connection_id` | `uuid` | NOT NULL, FK → `sp_shopify_connections(id)` ON DELETE CASCADE |
| `project_id` | `uuid` | NOT NULL, FK → `sp_projects(id)` ON DELETE CASCADE |
| `event_type` | `text` | NOT NULL, `installed` / `reconnected` / `token_refreshed` / `reauth_required` / `disconnected` / `uninstalled` |
| `metadata` | `jsonb` | nullable, **secret-bearing keys rejected by CHECK** (§N) |
| `created_at` | `timestamptz` | NOT NULL, `default now()` |

- Trigger `sp_shopify_connection_events_enforce_project` guarantees
  `project_id` matches the connection's project on every row.
- Rows are written only by the SECURITY DEFINER functions; no mutation policy
  exists for `anon`/`authenticated`.

## F. Indexes & Uniqueness Invariants

Connections: `project_id`, `shop_domain`, `status`, `user_id` lookup indexes,
plus two **partial unique indexes**:

```sql
CREATE UNIQUE INDEX sp_shopify_connections_one_active_per_project
  ON sp_shopify_connections(project_id) WHERE status = 'connected';

CREATE UNIQUE INDEX sp_shopify_connections_one_active_per_shop
  ON sp_shopify_connections(shop_domain) WHERE status = 'connected';
```

Events: `connection_id`, `project_id`, `event_type` lookup indexes.

Guaranteed invariants (tested C.1–C.3, J.1):

- A project has at most one **active** connection.
- A shop domain has at most one **active** connection across all projects.
- `disconnected` / `reauth_required` / `uninstalled` history rows coexist
  freely with the new active row — history is preserved, never overwritten.

## G. Status Model

| Status | Meaning |
|---|---|
| `connected` | Active; tokens valid or refreshable |
| `reauth_required` | Tokens invalid/expired; merchant must re-authorize |
| `disconnected` | User-initiated disconnect |
| `uninstalled` | Shopify app uninstall webhook received |

## H. Vault Model & Payload Whitelist

- One encrypted JSON secret per connection, created via
  `vault.create_secret(new_secret, new_name, new_description, new_key_id)`.
- Secret name: `shopify-tokens-<connection_id>`.
- **Whitelisted payload** (built with `jsonb_build_object` + `jsonb_strip_nulls`):
  `{"access_token": "...", "refresh_token": "..."}` — nothing else from the
  raw OAuth response can ride along.
- Non-secret data lives in columns: `granted_scopes`, `access_token_expires_at`,
  `refresh_token_expires_at`.
- `sp_shopify_connections.vault_secret_id` references the secret; the
  reference is nulled on revoke.
- `vault.secrets` / `vault.decrypted_secrets`: grants restricted to
  `postgres` + `service_role`; `anon`/`authenticated` hold no SELECT and no
  EXECUTE on `vault.create_secret`/`vault.update_secret` (verified locally and
  asserted by tests H.6/H.7/I.4/I.5; matches the Phase 2B.2 cloud preflight).
- Token material never appears in logs, API responses, ordinary tables, or
  the browser (tested I.1–I.3).

## I. SECURITY DEFINER Functions & EXECUTE Grants

| Function | Returns | EXECUTE grants | Purpose |
|---|---|---|---|
| `store_connection_tokens(p_project_id, p_shop_domain, p_token_payload)` | `uuid` | `service_role` only | Validate + normalize + upsert metadata, create/update Vault secret, log event — atomically |
| `get_connection_metadata(p_project_id)` | `TABLE(shop_domain, status, granted_scopes, installed_at, disconnected_at, last_verified_at)` | `authenticated` (+ `service_role` via Supabase default privileges) | Safe wizard metadata; never touches Vault |
| `get_connection_tokens(p_project_id)` | `TABLE(shop_domain, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at)` | `service_role` only | Decrypt round-trip from Vault for server-side use (future 2B.3B) |
| `revoke_connection_tokens(p_project_id, p_reason)` | `void` | `service_role` only | Delete Vault secret, null reference, mark `disconnected`/`uninstalled`, log event |

All four: `SECURITY DEFINER`, `SET search_path = ''`, fully
schema-qualified references. Every function explicitly revokes
`PUBLIC`/`anon`/`authenticated` before granting (§C.2). There is deliberately
**no browser-callable function that returns decrypted Vault material** — the
original draft's separate ownership helper was dropped entirely (inlined),
shrinking the attack surface.

`store_connection_tokens` input contract (validated before any write):
payload must be a JSON object with a non-empty string `access_token`;
`refresh_token` must be a string when present; `p_shop_domain` must be
non-empty after trim/lower.

## J. RLS Policies

Both tables: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`
(tested H.1).

`sp_shopify_connections`

| Role | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|
| `authenticated` | Own rows only — double check: `user_id = auth.uid()` **and** `EXISTS(project owned by auth.uid())` | No policy → denied |
| `anon` | No policy → 0 rows | No policy → denied |

`sp_shopify_connection_events`

| Role | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|
| `authenticated` | Events whose connection is owned by `auth.uid()` | No policy → denied |
| `anon` | No policy → 0 rows | No policy → denied |

Tests H.3/H.4 assert no policy exists for `anon` and no mutation policy
exists for `anon`/`authenticated` on either table. All mutations happen only
through the SECURITY DEFINER functions (server-side).

## K. Atomicity & Failure Safety (proven, not claimed)

`store_connection_tokens` executes as **one implicit PostgreSQL
transaction**: derive ownership → validate/normalize → upsert metadata →
`vault.create_secret`/`vault.update_secret` → set `vault_secret_id` → insert
event. PL/pgSQL functions cannot commit mid-function, and
`vault.create_secret` performs ordinary SQL in the caller's transaction —
**verified empirically**:

- **M.1 (savepoint rollback)**: calling the function then
  `ROLLBACK TO SAVEPOINT` removes *both* the connection row *and* the Vault
  secret it created — proving Vault writes are not autonomous and share the
  caller's transaction (no orphan-secret window).
- **M.2 (in-function failure)**: a store violating the one-active-per-shop
  index fails as a whole — zero partial metadata rows and zero new Vault
  secrets (counts asserted before/after).
- **M.3**: invalid payload (missing `access_token`) is rejected before any
  write.

Therefore: no `status='connected'` row without a Vault secret, no Vault
secret without a referencing row, no event without a connection.

`revoke_connection_tokens` order: delete Vault secret **first**, then mark
`disconnected`/`uninstalled` and null the reference, then log the event. If a
future change ever split the transaction, the failure mode is "tokens gone,
row still recoverable" — never "row disconnected, tokens left in Vault".

## L. Server-Only Boundary

- `service_role` key exists only in server-only application code; never in
  client components, never in the browser bundle (Phase 2B.2 test: "env
  module: SHOPIFY_CLIENT_SECRET is never read outside src/lib/shopify"
  remains green; no client code touched in this phase).
- `get_connection_metadata` is the only 2B.3A function reachable by
  `authenticated`, and it returns only safe columns (asserted by F.1–F.8 and
  I.3).
- No generic browser-callable token getter exists (asserted F.4).

## M. Identity / Ownership Invariants

A connection can never be created for a project the actor does not own.
Enforced in three independent layers:

1. `store_connection_tokens` derives `user_id` from `sp_projects.user_id`
   (never from client input) and raises if the project does not exist.
2. RLS SELECT requires `user_id = auth.uid()` **and** an EXISTS project
   ownership check — a forged `user_id` alone or a foreign `project_id` alone
   cannot read a row.
3. The ownership trigger re-derives the owner from `sp_projects` on every
   direct INSERT/UPDATE, even for `service_role`/superuser write paths
   (tested K.1–K.3; replaces the illegal CHECK — §C.1).

## N. Secret-Less Events: Database Enforcement

The spec's "events must never contain secrets" is enforced **in the
database**, not by convention:

```sql
CONSTRAINT sp_shopify_connection_events_metadata_no_secrets
CHECK (metadata IS NULL OR metadata::text !~*
  '"(access_token|refresh_token|authorization_code|client_secret|refresh_token_expires_at|refresh_token_expires_in|expires_in|expires_at|state|cookie|cookies|set-cookie|code|token|tokens|jwt|password|secret|hmac)"\s*:')
```

- Matches forbidden JSON keys at **any nesting depth** in the serialized
  document, and also catches a benign-looking value that embeds such a JSON
  fragment (the realistic leakage vector).
- Applies to **every** write path, including `service_role` and direct SQL.
- Tested: L.1 top-level `access_token` rejected, L.2 nested
  `refresh_token` rejected, L.3 `state`/`code` rejected, L.4 benign metadata
  still accepted (no over-blocking).
- Documented limitation: pattern-based; it cannot semantically detect a
  token-shaped string hidden behind a benign key name — the server layer
  remains responsible for only ever passing non-secret metadata.

## O. Migration Files & Application Status

| File | Purpose |
|---|---|
| `supabase/migrations/20260921000000_create_sp_shopify_connections.sql` | Connections table, indexes, ownership trigger, RLS |
| `supabase/migrations/20260921000100_create_sp_shopify_connection_events.sql` | Events table, consistency trigger, secret-key CHECK, RLS |
| `supabase/migrations/20260921000200_create_shopify_security_definer_functions.sql` | SECURITY DEFINER functions + explicit GRANT/REVOKE |

- The three files were corrected **in place** rather than adding fix-up
  migrations because, at correction time, they had never been applied to any
  database (verified against `supabase_migrations.schema_migrations`
  locally; cloud held only the two Phase 2A migrations).
- **Local**: applied cleanly from scratch via `supabase db reset` on
  PostgreSQL 17.6 (`supabase/postgres:17.6.1.165`), recording all five
  migrations (2 Phase 2A + 3 Phase 2B.3A). Vault: `supabase_vault` 0.3.1.
- **Cloud `nchxfngytvchlnlogeuy`**: applied via MCP `apply_migration` after
  a cloud-side preflight; migration history now records all five migrations
  (new versions `20260922134618` / `20260922134639` / `20260922134716`).
  Details in §Q.

## P. Test Coverage & Local Results

File: `supabase/tests/rls_shopify_connections_tests.sql` — single transaction,
rolls back completely, re-runnable, no real tokens (fixtures are
unmistakably fake: `shpat_FAKETOKEN...` / `shprr_FAKETOKEN...`).

| Scenario | Assertions |
|---|---|
| Setup | Connection created through the real `service_role` → `store_connection_tokens` path; metadata + event written together |
| A | Owner SELECTs own connection/events; shop domain normalized; `get_connection_metadata` works |
| B | User B cannot read User A's connections, events, or metadata RPC |
| C | Partial unique indexes (one active per project, one active per shop); disconnect via sanctioned path; history coexists |
| D | Owner cannot UPDATE/DELETE (0 rows) or INSERT (denied) directly |
| E | Anon: 0 rows on both tables; INSERT denied on both |
| F | EXECUTE-grant matrix (anon ✗, authenticated ✗ on token functions, service_role ✓); no residual PUBLIC grant; call-time denial for authenticated/anon on all token functions; `get_connection_metadata` denied to anon |
| G | Vault round-trip: store → decrypt (exact fixture match + expiry timestamps) → secret naming/link → revoke removes secret, nulls reference, logs event; getter returns nothing when disconnected |
| H | RLS ENABLED + FORCED both tables; SELECT policy exists; no anon policy; no mutation policy; vault extension present; vault grants + EXECUTE isolation |
| I | Only `*_expires_at` token-ish columns exist; no token strings anywhere in either table; metadata RPC output clean; `vault.decrypted_secrets`/`vault.secrets` inaccessible to authenticated |
| J | `reauth_required` + `disconnected` history preserved beside new active row |
| K | Ownership trigger rejects forged `user_id` and nonexistent project; accepts correct owner |
| L | Event metadata CHECK rejects secret-bearing keys (top-level + nested + state/code) at DB level; accepts benign metadata |
| M | Atomicity: savepoint rollback removes connection row **and** Vault secret; failed store leaves no orphan secret/partial row; invalid payload rejected pre-write |

**Results (clean `supabase db reset` → both suites):**

- `rls_shopify_connections_tests.sql` — **57/57 PASS** (`=== ALL SHOPIFY RLS TESTS PASSED (A-M) ===`)
- `rls_security_tests.sql` (Phase 2A regression) — **25/25 PASS** (`=== ALL RLS TESTS PASSED (A-H) ===`)

Both suites were then run **identically against cloud project
`nchxfngytvchlnlogeuy`** and passed there as well (§Q).

## Q. Cloud Verification Status — APPLIED & VERIFIED ✅

All three migrations have been applied to cloud project
`nchxfngytvchlnlogeuy` and both SQL suites ran green against it.

**Access path**: the original MCP config pointed at an unrelated project
(`fdpevqnnfwqixllrpdqo` — never written to). The user re-pointed the
Supabase MCP at `nchxfngytvchlnlogeuy`; the binding was verified with
`get_project_url` (returned `https://nchxfngytvchlnlogeuy.supabase.co`)
**before** any write.

**Cloud preflight (repeated on the target, matching the local stack and the
Phase 2B.2 cloud preflight):**

1. `supabase_vault` 0.3.1 installed.
2. `vault.create_secret(text, text, text, uuid)` and
   `vault.update_secret(uuid, text, text, text, uuid)` signatures match the
   migrations exactly.
3. `vault.decrypted_secrets.decrypted_secret` is `text` (hence the `::jsonb`
   cast in `get_connection_tokens`).
4. Vault grants: only `postgres` + `service_role` hold privileges on
   `vault.secrets` / `vault.decrypted_secrets`; `anon`/`authenticated` hold
   none and cannot EXECUTE the vault functions.

**Application**: three `apply_migration` calls, in order. Migration history
now records:

| version | name |
|---|---|
| `20260918074226` | `20260917120000_create_sp_projects` (pre-existing) |
| `20260918074259` | `20260917120100_create_sp_business_profiles` (pre-existing) |
| `20260922134618` | `20260921000000_create_sp_shopify_connections` |
| `20260922134639` | `20260921000100_create_sp_shopify_connection_events` |
| `20260922134716` | `20260921000200_create_shopify_security_definer_functions` |

**Post-migration structural verification (queried from the cloud DB):**

- Both tables present with `relrowsecurity = true` AND `relforcerowsecurity = true`.
- All six functions present (four API + two triggers).
- EXECUTE grant matrix exactly as designed:
  `get_connection_metadata` anon=false / authenticated=true / service_role=true;
  `store_connection_tokens`, `get_connection_tokens`, `revoke_connection_tokens`
  anon=false / authenticated=false / service_role=true.
- Residual PUBLIC EXECUTE grants on the four functions: **0**.
- Both partial unique indexes present; events secret-key CHECK
  (`sp_shopify_connection_events_metadata_no_secrets`) present.

**Test suites on cloud** (executed as a single transaction over `execute_sql`;
every assertion raises an exception on failure, so a clean completion is a
pass — confirmed by a completion-marker row returned as the final statement):

- `rls_shopify_connections_tests.sql` — **57/57 PASS**
  (`CLOUD_SHOPIFY_SUITE_COMPLETED_OK`, zero errors)
- `rls_security_tests.sql` (Phase 2A regression) — **25/25 PASS**
  (`CLOUD_PHASE2A_SUITE_COMPLETED_OK`, zero errors)

**Residue check after the suites** (they roll back by design):
`0` connections, `0` events, `0` `shopify-tokens-%` vault secrets,
`0` test users — cloud production data untouched.

## R. Quality Gates

| Gate | Result |
|---|---|
| `npm run test:shopify` | ✅ 46/46 assertions passed |
| `npm run check:css` | ✅ passed (65 source files) |
| `npm run lint` | ✅ passed (0 errors, 0 warnings) |
| `npx tsc --noEmit` | ✅ passed |
| `npm run build` | ✅ passed (Next.js 16.3.5, 8 pages generated) |
| `supabase db reset` (all migrations, clean DB) | ✅ passed (PostgreSQL 17.6, `supabase_vault` 0.3.1) |
| SQL: `rls_shopify_connections_tests.sql` (local) | ✅ 57/57 PASS |
| SQL: `rls_security_tests.sql` (Phase 2A, local) | ✅ 25/25 PASS |
| Cloud: migrations applied to `nchxfngytvchlnlogeuy` (`apply_migration` ×3) | ✅ history shows all 5 migrations |
| Cloud: `rls_shopify_connections_tests.sql` (57 assertions, single transaction) | ✅ completed with zero errors + completion marker |
| Cloud: `rls_security_tests.sql` (Phase 2A,25 assertions) | ✅ completed with zero errors + completion marker |
| Cloud: structural verification (FORCE RLS, grant matrix, PUBLIC ACL, unique indexes, secret-key CHECK) | ✅ all exact matches |
| Cloud: residue check after test suites (rollback proof) | ✅ 0 connections / 0 events / 0 vault secrets / 0 test users |
| Secret scan (changed files vs `.env.local` values + token/JWT/key patterns) | ✅ 0 leaks; only fake `FAKETOKEN` fixtures present |

## S. Secret Scan

- No `.env.local` value (`SHOPIFY_CLIENT_SECRET`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SHOPIFY_APP_URL`) appears in any
  changed file.
- Pattern scan for Shopify tokens (`shpat_`/`shprr_`/`shpca_`), Supabase
  secret keys (`sb_secret_`), JWTs (`eyJ...`), GitHub/AWS key shapes across
  all changed files: only `FAKETOKEN` fixtures matched — verified uniform
  (46 chars) so assertions are exact.
- No real production token is present in the repository or test suite.
- Untracked junk file `nul` (accidental shell-redirect artifact containing a
  `psql not found` message) was removed, not committed.

## T. Security Notes & Residual Risks

1. **service_role remains the crown jewel** — it can read Vault directly and
   bypass RLS. This is a deliberate, documented boundary (Supabase's standard
   server-side model). Mitigation: the key lives only in server-only code;
   tests assert anon/authenticated cannot reach Vault or the token functions.
2. **Default-privilege regression risk** — if a function is ever `DROP`ped and
   re-created outside these migrations, Supabase defaults would re-grant
   EXECUTE to `anon`/`authenticated`. Test scenario F exists precisely to
   catch this on every run.
3. **Events CHECK is pattern-based** (§N) — deep defense, not a proof; server
   discipline still required.
4. **One active connection per shop globally** means an admin connecting a
   shop already active elsewhere must first disconnect the other project —
   the unique index fails closed (tested C.2, M.2).
5. **Vault secret for a `disconnected`-via-direct-update row**: all sanctioned
   disconnects go through `revoke_connection_tokens`, which deletes the
   secret; only server-side bypass writes could orphan a secret, and M-path
   tests pin the sanctioned behavior.

## U. Remaining Work

**Phase 2B.3A is complete**: foundation implemented, locally verified
(57/57 + 25/25 on a clean reset), applied to cloud `nchxfngytvchlnlogeuy`,
and verified there (structural checks + both suites + residue check).

Remaining work is Phase 2B.3B scope:

1. Wire OAuth callback persistence: call `store_connection_tokens` from
   `src/app/api/shopify/callback/route.ts` (server-only).
2. Implement `src/lib/shopify/tokens.ts` server-only module (store/get/
   refresh/revoke via the four functions).
3. Token refresh HTTP calls + `token_refreshed` events + Vault rotation.
4. Wizard UI connection status via `get_connection_metadata`.
5. Disconnect/reconnect flow.
6. Uninstall webhook handler design (registration deferred).
