-- ============================================================================
-- StorePilot Phase 2B.3A — Shopify connection SECURITY DEFINER functions
-- ----------------------------------------------------------------------------
-- These functions are the ONLY sanctioned path for mutating or reading
-- Shopify connection state. They enforce:
--
--   1. Ownership derivation from sp_projects, never from client input.
--   2. Atomicity: Vault secret creation/update and metadata changes happen in
--      the same transaction, so a failure leaves no orphaned 'connected' row
--      without a Vault secret, and vice-versa.
--   3. Event logging for every state transition.
--   4. search_path is pinned to '' to defeat search_path-hijacking.
--   5. Schema objects are fully qualified.
--
-- EXECUTE grants (verified by supabase/tests/rls_shopify_connections_tests.sql
-- scenario F). PostgreSQL grants EXECUTE to PUBLIC by default, and Supabase's
-- default function privileges additionally auto-grant new public-schema
-- functions to service_role, so every function below has the PUBLIC/anon/
-- authenticated default explicitly REVOKED first; without that, anon and
-- authenticated could RPC-call the token functions:
--
--   get_connection_metadata  -> authenticated ONLY (+ service_role via
--                               Supabase default privileges: harmless, it is
--                               the trusted server role)
--   store_connection_tokens  -> service_role ONLY   (writes Vault)
--   get_connection_tokens    -> service_role ONLY   (reads Vault)
--   revoke_connection_tokens -> service_role ONLY   (deletes Vault)
--
-- There is deliberately NO browser-callable function that returns decrypted
-- Vault material. service_role is the server-side boundary: its key exists
-- only in server-only application code, never in the browser.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- store_connection_tokens
--
-- Inserts or updates a Shopify connection and its Vault secret atomically.
-- Returns the connection UUID on success.
--
-- Input token payload shape (JSONB — as returned by Shopify's
-- /admin/oauth/access_token with expiring tokens):
--   { "access_token": "...",          -- required, string
--     "refresh_token": "...",         -- optional string (expiring offline flow)
--     "expires_in": 3600,             -- optional number -> metadata column
--     "refresh_token_expires_in": ...,-- optional number -> metadata column
--     "scope": "" }                   -- optional string -> granted_scopes column
--
-- ONLY access_token and refresh_token are written to Vault (report §6).
-- Scopes and expiries are non-secret metadata and go to table columns.
--
-- Caller: server-only (service_role key in server-only code). Never exposed
-- to the browser.
-- ---------------------------------------------------------------------------
create or replace function public.store_connection_tokens(
  p_project_id uuid,
  p_shop_domain text,
  p_token_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_user_id uuid;
  v_connection_id uuid;
  v_vault_secret_id uuid;
  v_vault_payload jsonb;
  v_shop_domain text;
  v_scopes text[];
  v_access_token_expires_at timestamptz;
  v_refresh_token_expires_at timestamptz;
  v_event_type text;
  v_updated boolean := false;
  v_now timestamptz := now();
begin
  -- ------------------------------------------------------------------
  -- 0. Input validation. Fail fast and loud; nothing is written yet.
  -- ------------------------------------------------------------------
  if p_token_payload is null or jsonb_typeof(p_token_payload) <> 'object' then
    raise exception 'store_connection_tokens: p_token_payload must be a JSON object';
  end if;

  if jsonb_typeof(p_token_payload->'access_token') is distinct from 'string'
     or coalesce(p_token_payload->>'access_token', '') = '' then
    raise exception 'store_connection_tokens: p_token_payload.access_token must be a non-empty string';
  end if;

  if p_token_payload ? 'refresh_token'
     and jsonb_typeof(p_token_payload->'refresh_token') is distinct from 'string' then
    raise exception 'store_connection_tokens: p_token_payload.refresh_token must be a string when present';
  end if;

  v_shop_domain := nullif(lower(btrim(coalesce(p_shop_domain, ''))), '');
  if v_shop_domain is null then
    raise exception 'store_connection_tokens: p_shop_domain must be a non-empty domain';
  end if;

  -- ------------------------------------------------------------------
  -- 1. Derive ownership from the project. Never trust client-supplied
  --    user_id. (Runs as the definer, i.e. with server privileges.)
  -- ------------------------------------------------------------------
  select user_id into v_owner_user_id
  from public.sp_projects
  where id = p_project_id;

  if v_owner_user_id is null then
    raise exception 'store_connection_tokens: project % not found', p_project_id;
  end if;

  -- ------------------------------------------------------------------
  -- 2. Non-secret metadata derived from the token response.
  --    Expiry TIMESTAMPS are metadata only; token strings never leave
  --    the vault payload built in step 4.
  -- ------------------------------------------------------------------
  v_access_token_expires_at :=
    case when jsonb_typeof(p_token_payload->'expires_in') = 'number'
      then v_now + ((p_token_payload->>'expires_in')::double precision * interval '1 second')
      else null
    end;

  v_refresh_token_expires_at :=
    case when jsonb_typeof(p_token_payload->'refresh_token_expires_in') = 'number'
      then v_now + ((p_token_payload->>'refresh_token_expires_in')::double precision * interval '1 second')
      else null
    end;

  -- Shopify returns scope as a comma-separated string. Zero-scope installs
  -- (Phase 2B) return "" -> empty array.
  select coalesce(array_remove(string_to_array(s, ','), ''), '{}')
    into v_scopes
  from (select coalesce(p_token_payload->>'scope', '') as s) t;

  -- ------------------------------------------------------------------
  -- 3. Upsert connection metadata idempotently.
  --    First try to UPDATE the project's active connection; else INSERT.
  --    Both paths trigger-verify user_id against the project owner.
  -- ------------------------------------------------------------------
  update public.sp_shopify_connections
     set shop_domain = v_shop_domain,
         granted_scopes = v_scopes,
         access_token_expires_at = v_access_token_expires_at,
         refresh_token_expires_at = v_refresh_token_expires_at,
         disconnected_at = null,
         last_verified_at = v_now,
         updated_at = v_now
   where project_id = p_project_id
     and status = 'connected'
  returning id, vault_secret_id into v_connection_id, v_vault_secret_id;

  if v_connection_id is not null then
    v_updated := true;
  end if;

  if v_connection_id is null then
    insert into public.sp_shopify_connections (
      project_id, user_id, shop_domain, status, granted_scopes,
      vault_secret_id, access_token_expires_at, refresh_token_expires_at,
      installed_at, last_verified_at
    ) values (
      p_project_id, v_owner_user_id, v_shop_domain, 'connected', v_scopes,
      null, v_access_token_expires_at, v_refresh_token_expires_at, v_now, v_now
    )
    returning id into v_connection_id;
  end if;

  -- ------------------------------------------------------------------
  -- 4. Store token material in Vault — WHITELISTED to the two token
  --    fields only, so nothing else from the raw OAuth response can ride
  --    along into the secret. If this connection already has a Vault
  --    secret, update it in place (no orphaned secrets on re-auth).
  -- ------------------------------------------------------------------
  v_vault_payload := jsonb_strip_nulls(jsonb_build_object(
    'access_token', p_token_payload->'access_token',
    'refresh_token', p_token_payload->'refresh_token'
  ));

  if v_vault_secret_id is not null then
    perform vault.update_secret(
      v_vault_secret_id,
      new_secret => v_vault_payload::text
    );
  else
    -- Argument order: (new_secret, new_name, new_description, new_key_id)
    select vault.create_secret(
      v_vault_payload::text,
      'shopify-tokens-' || v_connection_id,
      'Shopify OAuth tokens for connection ' || v_connection_id
    ) into v_vault_secret_id;
  end if;

  -- ------------------------------------------------------------------
  -- 5. Record the Vault secret reference on the connection row.
  -- ------------------------------------------------------------------
  update public.sp_shopify_connections
     set vault_secret_id = v_vault_secret_id,
         updated_at = v_now
   where id = v_connection_id;

  -- ------------------------------------------------------------------
  -- 6. Log the lifecycle event (non-secret metadata only).
  -- ------------------------------------------------------------------
  if v_updated then
    v_event_type := 'reconnected';  -- re-auth on the project's active row
  elsif exists (
    select 1 from public.sp_shopify_connections
    where project_id = p_project_id
      and id <> v_connection_id      -- any row other than the one just added
  ) then
    v_event_type := 'reconnected';  -- project has connection history
  else
    v_event_type := 'installed';    -- first-ever connection for this project
  end if;

  insert into public.sp_shopify_connection_events (
    connection_id, project_id, event_type, metadata
  ) values (
    v_connection_id,
    p_project_id,
    v_event_type,
    jsonb_build_object('shop_domain', v_shop_domain)
  );

  return v_connection_id;
  -- Any exception above propagates to the caller and rolls back the whole
  -- transaction (steps 1-6 are one implicit transaction), which is what makes
  -- "status=connected but no Vault secret" impossible. See report §9.
end;
$$;

comment on function public.store_connection_tokens is
  'Server-only (service_role). Atomically stores access_token+refresh_token in Vault and upserts connection metadata. Never returns token material. EXECUTE revoked from PUBLIC/anon/authenticated.';

-- ---------------------------------------------------------------------------
-- get_connection_metadata
--
-- Returns safe, non-secret connection metadata for the wizard UI: the most
-- relevant row for the project (active connection first, else latest
-- history). Never touches Vault, never returns token material.
-- Caller: authenticated role (ownership enforced inside the function).
-- ---------------------------------------------------------------------------
create or replace function public.get_connection_metadata(
  p_project_id uuid
)
returns table (
  shop_domain text,
  status text,
  granted_scopes text[],
  installed_at timestamptz,
  disconnected_at timestamptz,
  last_verified_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select
    sc.shop_domain,
    sc.status,
    sc.granted_scopes,
    sc.installed_at,
    sc.disconnected_at,
    sc.last_verified_at
  from public.sp_shopify_connections sc
  where sc.project_id = p_project_id
    and exists (
      select 1 from public.sp_projects p
      where p.id = p_project_id
        and p.user_id = (select auth.uid())
    )
  order by (sc.status = 'connected') desc, sc.updated_at desc
  limit 1;
end;
$$;

comment on function public.get_connection_metadata is
  'Safe metadata only: shop domain, status, scopes, timestamps. No token material, no Vault reference. Callable by authenticated users for their own projects.';

-- ---------------------------------------------------------------------------
-- get_connection_tokens
--
-- Returns decrypted token material from Vault for a project's active
-- connection, together with the non-secret expiry metadata needed by the
-- future refresh logic (Phase 2B.3B).
--
-- Caller: service_role ONLY (server-side). The ownership EXISTS-check used
-- in an earlier draft was removed deliberately: auth.uid() is NULL in the
-- trusted server context, which would have made the function return nothing
-- for its only legitimate caller. The EXECUTE grant is the boundary here.
-- ---------------------------------------------------------------------------
create or replace function public.get_connection_tokens(
  p_project_id uuid
)
returns table (
  shop_domain text,
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select
    sc.shop_domain,
    (vs.decrypted_secret::jsonb ->> 'access_token')::text,
    (vs.decrypted_secret::jsonb ->> 'refresh_token')::text,
    sc.access_token_expires_at,
    sc.refresh_token_expires_at
  from public.sp_shopify_connections sc
  join vault.decrypted_secrets vs on vs.id = sc.vault_secret_id
  where sc.project_id = p_project_id
    and sc.status = 'connected';
end;
$$;

comment on function public.get_connection_tokens is
  'Returns decrypted Shopify tokens from Vault. Server-only: EXECUTE granted to service_role exclusively. Never callable by anon/authenticated, never returned to browser. Note: vault.decrypted_secrets.decrypted_secret is text in supabase_vault 0.3.1, hence the ::jsonb cast.';

-- ---------------------------------------------------------------------------
-- revoke_connection_tokens
--
-- Deletes the Vault secret and marks the connection disconnected/uninstalled.
-- Caller: service_role only.
--
-- Ordering rationale: the Vault secret is deleted first. Because both steps
-- are one transaction this is not strictly required for consistency, but it
-- keeps the "worst case if a future change ever splits the transaction"
-- failure mode as: tokens gone, row still marked connected (recoverable) —
-- rather than row disconnected while tokens remain in Vault (silent leak).
-- ---------------------------------------------------------------------------
create or replace function public.revoke_connection_tokens(
  p_project_id uuid,
  p_reason text default 'disconnected'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection_id uuid;
  v_vault_secret_id uuid;
  v_event_type text;
begin
  -- Find the most relevant non-terminal connection for this project.
  select id, vault_secret_id
    into v_connection_id, v_vault_secret_id
  from public.sp_shopify_connections
  where project_id = p_project_id
    and status in ('connected', 'reauth_required')
  order by (status = 'connected') desc, updated_at desc
  limit 1;

  if v_connection_id is null then
    return; -- nothing to revoke
  end if;

  -- 1. Delete the Vault secret FIRST (see ordering rationale above).
  if v_vault_secret_id is not null then
    delete from vault.secrets where id = v_vault_secret_id;
  end if;

  -- 2. Mark the connection disconnected/uninstalled and drop the reference.
  v_event_type := case when p_reason = 'uninstalled' then 'uninstalled' else 'disconnected' end;

  update public.sp_shopify_connections
     set status = v_event_type,
         disconnected_at = now(),
         vault_secret_id = null,
         updated_at = now()
   where id = v_connection_id;

  -- 3. Log the event (metadata: reason only — no tokens, no state).
  insert into public.sp_shopify_connection_events (
    connection_id, project_id, event_type, metadata
  ) values (
    v_connection_id,
    p_project_id,
    v_event_type,
    jsonb_build_object('reason', p_reason)
  );
end;
$$;

comment on function public.revoke_connection_tokens is
  'Deletes Vault secret and marks connection disconnected/uninstalled. Server-only: EXECUTE granted to service_role exclusively.';

-- ---------------------------------------------------------------------------
-- GRANTS — the load-bearing part
-- ---------------------------------------------------------------------------
-- 1. PostgreSQL grants EXECUTE to PUBLIC by default. Revoke that everywhere
--    first, otherwise anon/authenticated could RPC-call the token functions.
revoke execute on function public.store_connection_tokens(uuid, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.get_connection_metadata(uuid)
  from public, anon, authenticated;
revoke execute on function public.get_connection_tokens(uuid)
  from public, anon, authenticated;
revoke execute on function public.revoke_connection_tokens(uuid, text)
  from public, anon, authenticated;

-- 2. Explicit allow-list:
--    * safe metadata  -> the signed-in user (wizard UI / PostgREST RPC)
--    * token functions -> service_role only (server-side boundary; the key
--      lives in server-only application code and never reaches the browser)
grant execute on function public.get_connection_metadata(uuid) to authenticated;
-- service_role's EXECUTE on get_connection_metadata arrives via Supabase's
-- default function privileges; stated explicitly here so the intent is on the
-- record (trusted server role, safe metadata only).
grant execute on function public.get_connection_metadata(uuid) to service_role;
grant execute on function public.store_connection_tokens(uuid, text, jsonb) to service_role;
grant execute on function public.get_connection_tokens(uuid) to service_role;
grant execute on function public.revoke_connection_tokens(uuid, text) to service_role;
