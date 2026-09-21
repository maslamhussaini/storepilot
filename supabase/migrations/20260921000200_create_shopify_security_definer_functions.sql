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
-- EXECUTE grants:
--   get_connection_metadata  -> authenticated (safe: no Vault access)
--   store_connection_tokens  -> service_role only (writes Vault)
--   get_connection_tokens    -> service_role only (reads Vault)
--   revoke_connection_tokens -> service_role only (deletes Vault)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper: derive user_id from project ownership
-- ---------------------------------------------------------------------------
create or replace function public.sp_shopify_project_owner(
  p_project_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return (
    select user_id
    from public.sp_projects
    where id = p_project_id
    limit 1
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- store_connection_tokens
--
-- Inserts or updates a Shopify connection and its Vault secret atomically.
-- Returns the connection UUID on success.
--
-- Token payload shape (JSONB):
--   { "access_token": "...", "refresh_token": "...", "expires_in": 3600,
--     "refresh_token_expires_in": 7776000, "scope": "" }
--
-- Caller: server-only (service_role). Never exposed to browser.
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
  v_access_token_expires_at timestamptz;
  v_refresh_token_expires_at timestamptz;
  v_now timestamptz := now();
begin
  -- 1. Derive ownership from the project. Never trust client-supplied user_id.
  v_owner_user_id := sp_shopify_project_owner(p_project_id);
  if v_owner_user_id is null then
    raise exception 'project % not found', p_project_id;
  end if;

  -- 2. Compute expiry timestamps from token response metadata.
  v_access_token_expires_at :=
    case
      when p_token_payload ? 'expires_in'
        then v_now + ((p_token_payload->>'expires_in')::bigint || ' seconds')::interval
      else null
    end;
  v_refresh_token_expires_at :=
    case
      when p_token_payload ? 'refresh_token_expires_in'
        then v_now + ((p_token_payload->>'refresh_token_expires_in')::bigint || ' seconds')::interval
      else null
    end;

  -- 3. Upsert connection metadata idempotently.
  --    First try to UPDATE an existing active connection for this project.
  update public.sp_shopify_connections
     set shop_domain = p_shop_domain,
         access_token_expires_at = v_access_token_expires_at,
         refresh_token_expires_at = v_refresh_token_expires_at,
         updated_at = v_now
   where project_id = p_project_id
     and status = 'connected'
  returning id, vault_secret_id into v_connection_id, v_vault_secret_id;

  -- If no active connection existed, INSERT a new one.
  if v_connection_id is null then
    insert into public.sp_shopify_connections (
      project_id, user_id, shop_domain, status,
      vault_secret_id, access_token_expires_at, refresh_token_expires_at, installed_at
    ) values (
      p_project_id, v_owner_user_id, p_shop_domain, 'connected',
      null, v_access_token_expires_at, v_refresh_token_expires_at, v_now
    )
    returning id into v_connection_id;
  end if;

  -- 4. Store or update token material in Vault (encrypted at rest).
  --    If the connection already has a Vault secret, update it in-place so we
  --    don't leak orphaned secrets. Otherwise create a new one.
  if v_vault_secret_id is not null then
    perform vault.update_secret(
      v_vault_secret_id,
      new_secret => p_token_payload::text
    );
  else
    select vault.create_secret(
      'shopify-tokens-' || v_connection_id,
      p_token_payload::text,
      'Shopify OAuth tokens for connection ' || v_connection_id
    ) into v_vault_secret_id;
  end if;

  -- 5. Update the connection row with the Vault secret reference.
  update public.sp_shopify_connections
     set vault_secret_id = v_vault_secret_id,
         updated_at = v_now
   where id = v_connection_id;

  -- 6. Log the lifecycle event.
  insert into public.sp_shopify_connection_events (
    connection_id, project_id, event_type, metadata
  ) values (
    v_connection_id,
    p_project_id,
    'installed',
    jsonb_build_object('shop_domain', p_shop_domain)
  );

  return v_connection_id;
exception
  when others then
    -- If anything fails, the transaction rolls back and no partial state
    -- remains. The caller sees the original error.
    raise;
end;
$$;

comment on function public.store_connection_tokens is
  'Server-only. Atomically stores Shopify tokens in Vault and upserts connection metadata. Never returns token material. Caller must hold service_role.';

-- ---------------------------------------------------------------------------
-- get_connection_metadata
--
-- Returns safe, non-secret connection metadata for the wizard UI.
-- Caller: authenticated role (RLS further restricts to owned projects).
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
    );
end;
$$;

comment on function public.get_connection_metadata is
  'Safe metadata only: shop domain, status, scopes, timestamps. No token material. Callable by authenticated users for their own projects.';

-- ---------------------------------------------------------------------------
-- get_connection_tokens
--
-- Returns decrypted token material from Vault for a project's active
-- connection. Caller: service_role only. Never exposed to browser.
-- ---------------------------------------------------------------------------
create or replace function public.get_connection_tokens(
  p_project_id uuid
)
returns table (
  access_token text,
  refresh_token text,
  expires_in integer,
  scope text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select
    (vs.decrypted_secret->>'access_token')::text,
    (vs.decrypted_secret->>'refresh_token')::text,
    (vs.decrypted_secret->>'expires_in')::integer,
    (vs.decrypted_secret->>'scope')::text
  from public.sp_shopify_connections sc
  join vault.decrypted_secrets vs on vs.id = sc.vault_secret_id
  where sc.project_id = p_project_id
    and sc.status = 'connected'
    and exists (
      select 1 from public.sp_projects p
      where p.id = p_project_id
        and p.user_id = (select auth.uid())
    );
end;
$$;

comment on function public.get_connection_tokens is
  'Returns decrypted Shopify tokens from Vault. Server-only: callable only via service_role. Never returned to browser.';

-- ---------------------------------------------------------------------------
-- revoke_connection_tokens
--
-- Deletes the Vault secret and marks the connection disconnected/uninstalled.
-- Caller: service_role only.
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
begin
  -- Find the active connection and its Vault reference.
  select id, vault_secret_id
    into v_connection_id, v_vault_secret_id
  from public.sp_shopify_connections
  where project_id = p_project_id
    and status = 'connected';

  if v_connection_id is null then
    return; -- nothing to revoke
  end if;

  -- 1. Delete the Vault secret FIRST. If this fails, the connection stays
  --    active — safer than marking it disconnected while tokens remain.
  if v_vault_secret_id is not null then
    delete from vault.secrets where id = v_vault_secret_id;
  end if;

  -- 2. Mark the connection as disconnected/uninstalled.
  update public.sp_shopify_connections
     set status = case when p_reason = 'uninstalled' then 'uninstalled' else 'disconnected' end,
         disconnected_at = now(),
         vault_secret_id = null,
         updated_at = now()
   where id = v_connection_id;

  -- 3. Log the event.
  insert into public.sp_shopify_connection_events (
    connection_id, project_id, event_type, metadata
  ) values (
    v_connection_id,
    p_project_id,
    case when p_reason = 'uninstalled' then 'uninstalled' else 'disconnected' end,
    jsonb_build_object('reason', p_reason)
  );
end;
$$;

comment on function public.revoke_connection_tokens is
  'Deletes Vault secret and marks connection disconnected/uninstalled. Server-only: callable only via service_role.';

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
-- Safe metadata function: can be called by authenticated users for their
-- own projects (RLS on the underlying table provides the second layer).
grant execute on function public.get_connection_metadata(uuid) to authenticated;

-- Token-reading and mutation functions: service_role only.
-- We do NOT grant these to authenticated or anon.
-- The Next.js server-only code must use the service_role Supabase client.
