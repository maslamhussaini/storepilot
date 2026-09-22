# StorePilot Phase 2B.3 — Implementation Plan

## Objective

Persist Shopify connections securely after successful OAuth, replacing the
Phase 2B.2 spike's intentional stateless discard with a production-grade
persistence layer.

## Scope

- Non-secret connection metadata in Supabase (`sp_shopify_connections`)
- Encrypted token material in Supabase Vault
- SECURITY DEFINER database functions for narrow server-side access
- RLS policies enforcing project ownership
- Wizard UI connection status
- Reconnect, disconnect, and webhook preparation

## Non-Scope (Do Not Implement Yet)

- Shopify product/collection scopes beyond zero
- Catalog import/build engine
- Webhook registration/verification (design only)
- Database migrations execution
- Vault secret creation for existing spike tokens

## Plan Corrections (from Phase 2B.3A discovery)

1. **Vault API**: Use `vault.create_secret()`, `vault.update_secret()`, and
   `vault.decrypted_secrets` view. The extension name is `supabase_vault`.
2. **Partial unique indexes**: Use partial unique indexes (not named UNIQUE
   constraints) for active-connection uniqueness. Disconnected historical rows
   naturally coexist.
3. **user_id denormalisation**: Follow `sp_business_profiles` ownership
   double-check pattern: store `user_id`, validate against both `auth.uid()`
   and project ownership via EXISTS.
4. **SECURITY DEFINER safety**: All functions use `SET search_path = ''` and
   fully qualified object names.
5. **Atomicity**: Vault + metadata + event operations occur in a single
   implicit PL/pgSQL transaction. No explicit COMMIT needed.
6. **Grants**: `get_connection_metadata` → `authenticated`; all token functions
   → `service_role` only.
7. **No subqueries in CHECK**: PostgreSQL rejects
   `CHECK (exists (select ...))` with "cannot use subquery in check
   constraint" (verified on PostgreSQL 17). The ownership invariant is
   enforced by a BEFORE INSERT/UPDATE trigger
   (`sp_shopify_connections_enforce_ownership`) instead, which also fails
   closed for non-RLS-bypassing writers.
8. **Vault decoding**: `vault.decrypted_secrets.decrypted_secret` is `text`
   (supabase_vault 0.3.1), not `jsonb` — the getter must cast `::jsonb`
   before using `->>`.
9. **EXECUTE grants are load-bearing**: PostgreSQL grants EXECUTE to PUBLIC by
   default and Supabase's default function privileges auto-grant new
   public-schema functions to `service_role`. Every function therefore
   explicitly REVOKEs PUBLIC/anon/authenticated first, then grants only the
   intended roles. Test scenario F proves the resulting matrix.
10. **No `auth.uid()` check in token functions**: `auth.uid()` is NULL in the
    trusted `service_role` context, so an ownership check there would return
    nothing for the only legitimate caller. The boundary is the EXECUTE
    grant. `get_connection_metadata` (the authenticated path) keeps the uid
    ownership check.
11. **Vault payload whitelist**: only `access_token` + `refresh_token` are
    written to Vault. `expires_in` / `refresh_token_expires_in` become
    `timestamptz` columns on the connection row; `scope` becomes
    `granted_scopes`.
12. **Secret-less events are DB-enforced**: a CHECK constraint on
    `sp_shopify_connection_events.metadata` rejects secret-bearing keys
    (access_token, refresh_token, authorization code, client_secret, OAuth
    state, cookies, ...) at any nesting depth, on every write path including
    `service_role`.
13. **`vault.create_secret` argument order**: `(new_secret, new_name,
    new_description, new_key_id)` — swapping secret and name is a silent
    failure that only the decrypt round-trip test (G.3) catches.
14. **Event type & normalization**: re-authentication logs `reconnected`
    (never `installed`); `store_connection_tokens` lowercases and trims
    `p_shop_domain` before persisting.
15. **Cloud execution path**: migrations are fully verified locally and were
    subsequently applied to and verified on cloud project
    `nchxfngytvchlnlogeuy` (see report §Q).

---

## Proposed Database Schema

### `sp_shopify_connections`

Non-secret installation/connection metadata, one row per active connection.

```sql
create table sp_shopify_connections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references sp_projects(id) on delete cascade,
  shop_domain text not null,
  shop_name text,
  installed_at timestamptz not null default now(),
  uninstalled_at timestamptz,
  is_active boolean not null default true,
  granted_scopes text[],
  token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  vault_secret_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unique_active_project unique (project_id) where is_active = true
);

create index idx_shopify_connections_project on sp_shopify_connections(project_id);
create index idx_shopify_connections_shop on sp_shopify_connections(shop_domain);
```

### `sp_shopify_connection_events`

Append-only audit/history of connection lifecycle events.

```sql
create table sp_shopify_connection_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references sp_shopify_connections(id) on delete cascade,
  event_type text not null check (event_type in ('installed', 'uninstalled', 'token_refreshed', 'reconnected')),
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index idx_shopify_events_connection on sp_shopify_connection_events(connection_id);
```

---

## Supabase Vault Strategy

- One encrypted JSON secret per active connection, stored via Supabase Vault
- Secret payload contains only: `access_token`, `refresh_token`, `expires_in`, `scope`
- Encrypted at rest using `pgsodium` or `pgcrypto` (platform-managed key)
- `vault_secret_id` on `sp_shopify_connections` references the Vault secret
- Accessible ONLY via SECURITY DEFINER database functions
- Never returned to browser, never logged, never exposed in API responses

---

## Server-Side Token Access Module

### `src/lib/shopify/tokens.ts` (new, server-only)

```typescript
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number | null;
  scope: string | null;
}

export async function storeShopifyTokens(projectId: string, shopDomain: string, tokenResponse: TokenResponse): Promise<void>
export async function getShopifyTokens(projectId: string): Promise<StoredTokens | null>
export async function refreshShopifyTokens(projectId: string): Promise<StoredTokens | null>
export async function revokeShopifyTokens(projectId: string): Promise<void>
export async function getConnectionStatus(projectId: string): Promise<{ connected: boolean; shopDomain: string | null }>
```

All functions are `import "server-only"` and route through SECURITY DEFINER DB functions.

---

## OAuth Callback Persistence Transaction

### Current (Phase 2B.2 spike)

```typescript
// Token exchange → extract metadata → discard body → redirect with shopify_spike=ok
```

### Phase 2B.3

```typescript
// Token exchange → extract metadata →
//   1. Normalize shop domain
//   2. Upsert sp_shopify_connections (idempotent on project_id + shop_domain)
//   3. Encrypt and store token material in Supabase Vault
//   4. Insert connection_event ('installed')
//   5. Redirect with connection status
```

**Idempotency**: If the same project/shop pair is re-authorized, update the
existing active connection rather than creating a duplicate.

---

## Reconnect / Disconnect Strategy

### Reconnect

- Wizard load calls `getConnectionStatus(projectId)`
- If connected and tokens valid: show "Connected" with shop domain
- If tokens expired: attempt refresh using stored refresh token
  - Success: update `token_expires_at`, log `token_refreshed` event
  - Failure: mark connection inactive, show "Reconnect" button
- If no active connection: show Connect form

### Disconnect

- User clicks "Disconnect" in wizard
- Server revokes tokens with Shopify (best effort)
- Clears Vault secret
- Marks `sp_shopify_connections.is_active = false`, sets `uninstalled_at`
- Logs `uninstalled` event
- UI returns to Connect form

### Uninstall Webhook

- Design `app/uninstalled` webhook handler (not yet registered)
- Handler marks connection inactive, clears tokens, logs event
- Idempotent: duplicate webhook deliveries do not create duplicate events

---

## Token Lifecycle Strategy

1. **Initial OAuth**: store tokens with `expires_in` and `refresh_token_expires_in` metadata
2. **Proactive refresh**: if `token_expires_at` is within 1 hour, refresh before use
3. **On-demand refresh**: if API call returns 401, refresh and retry once
4. **Refresh failure**: if refresh token is invalid/expired, mark as needing re-auth
5. **Rotation**: Shopify's expiring offline tokens rotate automatically on each refresh
6. **Revocation**: on disconnect or uninstall, revoke access token and clear Vault

---

## Security / RLS Strategy

### `sp_shopify_connections` RLS

```sql
-- Users can view connections for their own projects
create policy "users_view_own_connections" on sp_shopify_connections
  for select using (
    project_id in (
      select id from sp_projects where user_id = auth.uid()
    )
  );

-- Users cannot insert/update/delete directly (server-only via SECURITY DEFINER)
create policy "users_no_direct_mutation" on sp_shopify_connections
  for all using (false);
```

### SECURITY DEFINER Functions

```sql
create or replace function public.store_connection_tokens(
  p_project_id uuid,
  p_shop_domain text,
  p_token_payload jsonb
) returns uuid language plpgsql security definer set search_path = '';

create or replace function public.get_connection_metadata(
  p_project_id uuid
) returns table (
  shop_domain text,
  status text,
  granted_scopes text[],
  installed_at timestamptz,
  disconnected_at timestamptz,
  last_verified_at timestamptz
) language plpgsql security definer set search_path = '';

create or replace function public.get_connection_tokens(
  p_project_id uuid
) returns table (
  access_token text,
  refresh_token text,
  expires_in integer,
  scope text
) language plpgsql security definer set search_path = '';

create or replace function public.revoke_connection_tokens(
  p_project_id uuid,
  p_reason text default 'disconnected'
) returns void language plpgsql security definer set search_path = '';
```

### Key Principles

- Token material never leaves the database via SQL result sets except through
  `get_connection_tokens`, which is callable by `service_role` only.
- All API routes needing tokens call server-only functions.
- Client-side wizard sees only connection status (boolean + shop domain) via
  `get_connection_metadata`, which IS callable by `authenticated`.
- `service_role` key used only in server-only modules, never imported client-side.
- All functions use `SET search_path = ''` and fully qualified object names.

---

## Wizard UI Changes

### Connect Step (post-OAuth)

- On load: check connection status
- If connected: show shop domain, connected date, "Disconnect" button
- If disconnected/expired: show Connect form (existing behavior)
- Success state: "Shopify authorization successful" with connection details

### Connection Status Display

- Visible in wizard header or progress indicator
- Shows: connected/disconnected, shop domain (if connected)
- No token material, no secrets, no scope details exposed to client

---

## Proposed Implementation Order

1. Database migrations (`sp_shopify_connections`, `sp_shopify_connection_events`)
2. SECURITY DEFINER functions for token storage/retrieval
3. RLS policies
4. `src/lib/shopify/tokens.ts` server-only module
5. Update OAuth callback to persist tokens and connection metadata
6. Update wizard UI to display connection status
7. Disconnect/reconnect flow
8. Webhook handler design (registration deferred to later phase)

---

## Acceptance Criteria

- [ ] Successful OAuth round-trip persists connection metadata to `sp_shopify_connections`
- [ ] Token material stored in Supabase Vault, never exposed to client
- [ ] Reconnect flow works for expired tokens
- [ ] Disconnect flow revokes tokens and marks connection inactive
- [ ] RLS prevents cross-project token access
- [ ] Wizard UI shows connection status without exposing secrets
- [ ] All existing Phase 2B.2 tests continue to pass
- [ ] No `access_token` or `refresh_token` values appear in client bundle or API responses
- [ ] Idempotent re-auth for same project/shop pair does not create duplicate connections
