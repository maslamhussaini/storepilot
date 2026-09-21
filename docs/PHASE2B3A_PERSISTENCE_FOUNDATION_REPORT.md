# StorePilot Phase 2B.3A — Persistence Foundation Report

## 1. Objective

Phase 2B.3A establishes the database and security foundation for persistent
Shopify connections. It does NOT wire OAuth callback persistence, persist the
current spike token, or change any production behavior.

## 2. Plan Corrections Discovered

The draft `docs/PHASE2B3_PLAN.md` contained several items that were corrected
during implementation:

1. **Vault API**: The draft referenced `pgsodium`/`pgcrypto` directly. The
   actual Supabase Vault API uses `vault.create_secret()`, `vault.update_secret()`,
   and the `vault.decrypted_secrets` view. The extension name is `supabase_vault`.

2. **Partial unique indexes**: The draft proposed a named UNIQUE constraint.
   Partial unique constraints require explicit constraint names and are less
   flexible than partial unique indexes. The final design uses partial unique
   indexes so disconnected historical rows naturally coexist with new active
   connections.

3. **user_id denormalisation**: The draft did not include `user_id` on
   `sp_shopify_connections`. Following the `sp_business_profiles` ownership
   double-check pattern, `user_id` is stored and validated against both
   `auth.uid()` and project ownership via EXISTS subquery.

4. **SECURITY DEFINER safety**: Added `SET search_path = ''` and fully
   qualified object names in all functions to defeat search_path-hijacking.

5. **Atomicity**: Confirmed that Vault secret creation + metadata upsert +
   event insert occur in a single implicit transaction within PL/pgSQL
   functions. No explicit COMMIT is needed; the caller's transaction provides
   atomicity.

## 3. Final Schema

### `sp_shopify_connections`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `project_id` | `uuid` | FK → `sp_projects(id)` ON DELETE CASCADE |
| `user_id` | `uuid` | FK → `auth.users(id)` ON DELETE CASCADE |
| `shop_domain` | `text` | NOT NULL |
| `status` | `text` | `connected` / `reauth_required` / `disconnected` / `uninstalled` |
| `granted_scopes` | `text[]` | nullable |
| `vault_secret_id` | `uuid` | nullable, references Vault secret |
| `access_token_expires_at` | `timestamptz` | nullable |
| `refresh_token_expires_at` | `timestamptz` | nullable |
| `installed_at` | `timestamptz` | nullable |
| `disconnected_at` | `timestamptz` | nullable |
| `last_verified_at` | `timestamptz` | nullable |
| `created_at` | `timestamptz` | `default now()` |
| `updated_at` | `timestamptz` | `default now()`, trigger-stamped |

**CHECK constraint**: `status IN ('connected', 'reauth_required', 'disconnected', 'uninstalled')`

**CHECK constraint**: `user_id` must match the owning project's `user_id`

### `sp_shopify_connection_events`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `connection_id` | `uuid` | FK → `sp_shopify_connections(id)` ON DELETE CASCADE |
| `project_id` | `uuid` | FK → `sp_projects(id)` ON DELETE CASCADE |
| `event_type` | `text` | `installed` / `reconnected` / `token_refreshed` / `reauth_required` / `disconnected` / `uninstalled` |
| `metadata` | `jsonb` | non-secret only |
| `created_at` | `timestamptz` | `default now()` |

**CHECK constraint**: `event_type IN ('installed', 'reconnected', 'token_refreshed', 'reauth_required', 'disconnected', 'uninstalled')`

## 4. Indexes

### `sp_shopify_connections`

- `sp_shopify_connections_project_id_idx` on `(project_id)`
- `sp_shopify_connections_shop_domain_idx` on `(shop_domain)`
- `sp_shopify_connections_status_idx` on `(status)`
- `sp_shopify_connections_user_id_idx` on `(user_id)`

### Partial unique indexes

```sql
CREATE UNIQUE INDEX sp_shopify_connections_one_active_per_project
  ON sp_shopify_connections(project_id)
  WHERE status = 'connected';

CREATE UNIQUE INDEX sp_shopify_connections_one_active_per_shop
  ON sp_shopify_connections(shop_domain)
  WHERE status = 'connected';
```

These enforce:
- A project has at most one active Shopify connection.
- A shop domain has at most one active connection across ALL projects.

Disconnected/uninstalled rows are excluded, preserving history.

### `sp_shopify_connection_events`

- `sp_shopify_connection_events_connection_id_idx` on `(connection_id)`
- `sp_shopify_connection_events_project_id_idx` on `(project_id)`
- `sp_shopify_connection_events_event_type_idx` on `(event_type)`

## 5. Status Model

| Status | Meaning |
|---|---|
| `connected` | Active connection, tokens valid or refreshable |
| `reauth_required` | Tokens invalid/expired, merchant must re-authorize |
| `disconnected` | User-initiated disconnect |
| `uninstalled` | Shopify app uninstall webhook received |

## 6. Vault Model

- One encrypted JSON secret per active Shopify connection, stored via
  `vault.create_secret()`.
- Secret name format: `shopify-tokens-<connection_id>`
- Secret payload: `{"access_token":"...","refresh_token":"...","expires_in":3600,"refresh_token_expires_in":7776000,"scope":""}`
- Encrypted at rest using Supabase's managed `pgsodium` key (never stored
  alongside data).
- `sp_shopify_connections.vault_secret_id` stores the Vault secret UUID.
- `vault.decrypted_secrets` view is NOT granted to `anon` or `authenticated`.
- Token material is never logged, never returned to browser, never included
  in API responses.

## 7. SECURITY DEFINER Functions

| Function | Returns | GRANT | Purpose |
|---|---|---|---|
| `store_connection_tokens(p_project_id, p_shop_domain, p_token_payload)` | `uuid` | `service_role` only | Atomically stores tokens in Vault and upserts connection metadata |
| `get_connection_metadata(p_project_id)` | `TABLE(...)` | `authenticated` | Safe metadata for wizard UI |
| `get_connection_tokens(p_project_id)` | `TABLE(access_token, refresh_token, ...)` | `service_role` only | Reads decrypted tokens from Vault |
| `revoke_connection_tokens(p_project_id, p_reason)` | `void` | `service_role` only | Deletes Vault secret and marks connection disconnected/uninstalled |

All functions:
- `SECURITY DEFINER`
- `SET search_path = ''`
- Fully schema-qualified object references

## 8. RLS Policies

### `sp_shopify_connections`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `authenticated` | Own projects only (double-check: user_id + project ownership) | None | None | None |
| `anon` | None | None | None | None |

SELECT policy: `user_id = auth.uid()` AND `EXISTS(SELECT 1 FROM sp_projects WHERE id = project_id AND user_id = auth.uid())`

### `sp_shopify_connection_events`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `authenticated` | Events for owned connections | None | None | None |
| `anon` | None | None | None | None |

SELECT policy: `EXISTS(SELECT 1 FROM sp_shopify_connections WHERE id = connection_id AND user_id = auth.uid())`

Both tables: `FORCE ROW LEVEL SECURITY`

## 9. Atomicity / Failure Safety

`store_connection_tokens` performs the following steps in a single implicit
transaction:

1. Derive `user_id` from project ownership (fails fast if project missing)
2. Compute expiry timestamps from token response
3. Upsert connection metadata (UPDATE existing active row, or INSERT new)
4. Create Vault secret via `vault.create_secret()`
5. Update connection row with `vault_secret_id`
6. Insert lifecycle event

If any step fails, the entire transaction rolls back. This guarantees:

- No `status = 'connected'` row without a corresponding Vault secret.
- No Vault secret without a connection row referencing it.
- No event without a connection row.

`revoke_connection_tokens` reverses this safely:

1. Delete Vault secret FIRST (safer: if this fails, tokens remain accessible)
2. Mark connection disconnected/uninstalled
3. Log event

## 10. Server-Only Boundary

- All SECURITY DEFINER functions are in the `public` schema with `search_path = ''`.
- `get_connection_metadata` is the ONLY Shopify connection function callable
  by the `authenticated` role.
- Token-reading and token-mutation functions require `service_role`.
- The Next.js app must use the `service_role` Supabase client in server-only
  Route Handlers / Server Actions that need token access.
- No Shopify connection function or table is ever imported from a Client Component.

## 11. Identity / Ownership Invariant

**A connection cannot be created for a project the actor does not own.**

Enforced at three layers:
1. `store_connection_tokens` derives `user_id` from `sp_projects.user_id`, never from client input.
2. RLS SELECT policy requires `user_id = auth.uid()` AND project ownership via EXISTS.
3. CHECK constraint on `sp_shopify_connections` verifies `user_id` matches the project's `user_id`.

## 12. Migration Files

| File | Purpose |
|---|---|
| `supabase/migrations/20260921000000_create_sp_shopify_connections.sql` | Connection metadata table, indexes, RLS |
| `supabase/migrations/20260921000100_create_sp_shopify_connection_events.sql` | Event audit table, indexes, RLS |
| `supabase/migrations/20260921000200_create_shopify_security_definer_functions.sql` | Server-only functions and grants |

## 13. Test Coverage

File: `supabase/tests/rls_shopify_connections_tests.sql`

| Scenario | Assertions |
|---|---|
| A | Owner can SELECT own safe metadata; `get_connection_metadata` works |
| B | User B cannot read User A's connections or events |
| C | Partial unique indexes: one active per project, one active per shop; disconnected history preserved |
| D | Authenticated cannot directly INSERT/UPDATE/DELETE connections |
| E | Anonymous sees zero rows and cannot mutate |
| F | Authenticated cannot call `store_connection_tokens`, `get_connection_tokens`, or `revoke_connection_tokens` |
| G | `service_role` can call all functions; Vault decryption works |
| H | RLS enabled/forced; policies count; anon excluded; Vault extension present |
| I | Token strings absent from metadata tables; `vault.decrypted_secrets` restricted |
| J | Reconnection after `reauth_required` creates new active row; old row preserved |

## 14. Cloud Verification Status

**BLOCKER**: Vault extension availability and exact column/function signatures
have not been verified on the cloud project `nchxfngytvchlnlogeuy`.

Required manual steps before applying migrations to production:

1. Confirm `supabase_vault` extension is installed:
   ```sql
   SELECT extname FROM pg_extension WHERE extname = 'supabase_vault';
   ```
2. Confirm `vault.create_secret()` and `vault.update_secret()` signatures match
   the documented API.
3. Confirm `vault.decrypted_secrets` view has columns: `id`, `name`,
   `description`, `decrypted_secret`, `created_at`, `updated_at`.
4. Apply migrations via Supabase CLI or psql.
5. Run `rls_shopify_connections_tests.sql` against the cloud database.

## 15. Quality Gates

| Gate | Result |
|---|---|
| `npm run test:shopify` | 46 passed |
| `npm run check:css` | passed |
| `npm run lint` | passed (0 errors, 0 warnings) |
| `npx tsc --noEmit` | passed |
| `npm run build` | passed |

## 16. Remaining Work for Phase 2B.3B

1. Verify and apply migrations to cloud Supabase (`nchxfngytvchlnlogeuy`)
2. Wire OAuth callback persistence (`store_connection_tokens` call in
   `src/app/api/shopify/callback/route.ts`)
3. Implement `src/lib/shopify/tokens.ts` server-only module
4. Wizard UI connection status display
5. Disconnect/reconnect flow
6. Uninstall webhook handler design (registration deferred)
7. Token refresh HTTP calls
8. Vault secret rotation on refresh
