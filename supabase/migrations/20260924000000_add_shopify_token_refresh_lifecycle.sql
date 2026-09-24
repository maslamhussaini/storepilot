-- ============================================================================
-- StorePilot Phase 2B.3B-2 — Shopify token refresh lifecycle
-- ----------------------------------------------------------------------------
-- Adds a durable refresh lease and credential generation to the existing
-- Vault-backed connection model. OAuth install/reauthorization and refresh
-- rotation use the same Vault secret; this migration does not introduce a
-- second token store.
--
-- Concurrency model:
--   * claim_connection_token_refresh obtains a short database lease before the
--     external Shopify request;
--   * complete_connection_token_refresh requires the same claim and credential
--     generation, rotates Vault, updates expiry metadata, increments the
--     generation, and emits token_refreshed in one transaction;
--   * an OAuth reauthorization increments the generation and clears the lease,
--     so an older in-flight refresh cannot overwrite a newer OAuth result;
--   * mark_connection_reauth_required is idempotent and removes invalid Vault
--     material while preserving the connection history.
--
-- All token functions are SECURITY DEFINER, search_path-pinned, and
-- service_role-only. No function below is granted to anon or authenticated.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Durable coordination metadata (non-secret)
-- ---------------------------------------------------------------------------
alter table public.sp_shopify_connections
  add column credential_version bigint not null default 1,
  add column refresh_claim_id uuid,
  add column refresh_claim_expires_at timestamptz;

alter table public.sp_shopify_connections
  add constraint sp_shopify_connections_credential_version_positive
    check (credential_version > 0),
  add constraint sp_shopify_connections_refresh_claim_pair
    check ((refresh_claim_id is null) = (refresh_claim_expires_at is null));

comment on column public.sp_shopify_connections.credential_version is
  'Monotonic generation for the Vault credential pair. Incremented by OAuth store and successful refresh; used to reject stale completions.';
comment on column public.sp_shopify_connections.refresh_claim_id is
  'Short-lived UUID lease held by a trusted server refresh attempt. Never a token value.';
comment on column public.sp_shopify_connections.refresh_claim_expires_at is
  'Expiry of the trusted server refresh lease. A crashed attempt can be reclaimed after this time.';

-- ---------------------------------------------------------------------------
-- Replace OAuth store function so reauthorization invalidates in-flight
-- refreshes. The body intentionally remains the same persistence path as
-- Phase 2B.3A, with the generation/lease invalidation added here.
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

  select user_id into v_owner_user_id
  from public.sp_projects
  where id = p_project_id;

  if v_owner_user_id is null then
    raise exception 'store_connection_tokens: project % not found', p_project_id;
  end if;

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

  select coalesce(array_remove(string_to_array(s, ','), ''), '{}')
    into v_scopes
  from (select coalesce(p_token_payload->>'scope', '') as s) t;

  update public.sp_shopify_connections
     set shop_domain = v_shop_domain,
         granted_scopes = v_scopes,
         access_token_expires_at = v_access_token_expires_at,
         refresh_token_expires_at = v_refresh_token_expires_at,
         disconnected_at = null,
         last_verified_at = v_now,
         refresh_claim_id = null,
         refresh_claim_expires_at = null,
         credential_version = credential_version + 1,
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
    select vault.create_secret(
      v_vault_payload::text,
      'shopify-tokens-' || v_connection_id,
      'Shopify OAuth tokens for connection ' || v_connection_id
    ) into v_vault_secret_id;
  end if;

  update public.sp_shopify_connections
     set vault_secret_id = v_vault_secret_id,
         updated_at = v_now
   where id = v_connection_id;

  if v_updated then
    v_event_type := 'reconnected';
  elsif exists (
    select 1 from public.sp_shopify_connections
    where project_id = p_project_id
      and id <> v_connection_id
  ) then
    v_event_type := 'reconnected';
  else
    v_event_type := 'installed';
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
end;
$$;

comment on function public.store_connection_tokens(uuid, text, jsonb) is
  'Server-only (service_role). Atomically stores OAuth access/refresh tokens in Vault, invalidates any refresh lease, and increments the credential generation.';

-- ---------------------------------------------------------------------------
-- Trusted server-only read by connection UUID
-- ---------------------------------------------------------------------------
create or replace function public.get_connection_tokens_by_id(
  p_connection_id uuid
)
returns table (
  connection_id uuid,
  project_id uuid,
  shop_domain text,
  status text,
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  credential_version bigint,
  refresh_claim_id uuid,
  refresh_claim_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select
    c.id,
    c.project_id,
    c.shop_domain,
    c.status,
    (vs.decrypted_secret::jsonb ->> 'access_token')::text,
    (vs.decrypted_secret::jsonb ->> 'refresh_token')::text,
    c.access_token_expires_at,
    c.refresh_token_expires_at,
    c.credential_version,
    c.refresh_claim_id,
    c.refresh_claim_expires_at
  from public.sp_shopify_connections c
  left join vault.decrypted_secrets vs on vs.id = c.vault_secret_id
  where c.id = p_connection_id;
end;
$$;

comment on function public.get_connection_tokens_by_id(uuid) is
  'Server-only (service_role). Returns the active or historical connection credential pair by connection UUID for trusted lifecycle code only.';

-- ---------------------------------------------------------------------------
-- Claim a refresh lease and return the current credential pair
-- ---------------------------------------------------------------------------
create or replace function public.claim_connection_token_refresh(
  p_connection_id uuid,
  p_claim_id uuid,
  p_expected_version bigint,
  p_lease_seconds integer default 60
)
returns table (
  claim_result text,
  connection_id uuid,
  project_id uuid,
  shop_domain text,
  status text,
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  credential_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.sp_shopify_connections%rowtype;
  v_access_token text;
  v_refresh_token text;
  v_now timestamptz := now();
begin
  if p_claim_id is null or p_expected_version is null then
    raise exception 'claim_connection_token_refresh: claim id and expected version are required';
  end if;
  if p_lease_seconds < 5 or p_lease_seconds > 300 then
    raise exception 'claim_connection_token_refresh: lease seconds must be between 5 and 300';
  end if;

  select * into v_connection
  from public.sp_shopify_connections
  where id = p_connection_id
  for update;

  if not found then
    return query
    select 'not_found'::text, null::uuid, null::uuid, null::text, null::text,
           null::text, null::text, null::timestamptz, null::timestamptz, null::bigint;
    return;
  end if;

  if v_connection.status is distinct from 'connected' then
    return query
    select 'not_connected'::text, v_connection.id, v_connection.project_id,
           v_connection.shop_domain, v_connection.status, null::text, null::text,
           v_connection.access_token_expires_at, v_connection.refresh_token_expires_at,
           v_connection.credential_version;
    return;
  end if;

  if v_connection.credential_version is distinct from p_expected_version then
    return query
    select 'version_conflict'::text, v_connection.id, v_connection.project_id,
           v_connection.shop_domain, v_connection.status, null::text, null::text,
           v_connection.access_token_expires_at, v_connection.refresh_token_expires_at,
           v_connection.credential_version;
    return;
  end if;

  if v_connection.refresh_claim_id is not null
     and v_connection.refresh_claim_expires_at > v_now
     and v_connection.refresh_claim_id is distinct from p_claim_id then
    return query
    select 'already_claimed'::text, v_connection.id, v_connection.project_id,
           v_connection.shop_domain, v_connection.status, null::text, null::text,
           v_connection.access_token_expires_at, v_connection.refresh_token_expires_at,
           v_connection.credential_version;
    return;
  end if;

  if v_connection.vault_secret_id is null
     or not exists (select 1 from vault.secrets s where s.id = v_connection.vault_secret_id) then
    return query
    select 'missing_vault'::text, v_connection.id, v_connection.project_id,
           v_connection.shop_domain, v_connection.status, null::text, null::text,
           v_connection.access_token_expires_at, v_connection.refresh_token_expires_at,
           v_connection.credential_version;
    return;
  end if;

  update public.sp_shopify_connections
     set refresh_claim_id = p_claim_id,
         refresh_claim_expires_at = v_now + make_interval(secs => p_lease_seconds),
         updated_at = v_now
   where id = p_connection_id;

  select
    (vs.decrypted_secret::jsonb ->> 'access_token')::text,
    (vs.decrypted_secret::jsonb ->> 'refresh_token')::text
  into v_access_token, v_refresh_token
  from vault.decrypted_secrets vs
  where vs.id = v_connection.vault_secret_id;

  return query
  select 'claimed'::text, v_connection.id, v_connection.project_id,
         v_connection.shop_domain, v_connection.status, v_access_token,
         v_refresh_token, v_connection.access_token_expires_at,
         v_connection.refresh_token_expires_at, v_connection.credential_version;
end;
$$;

comment on function public.claim_connection_token_refresh(uuid, uuid, bigint, integer) is
  'Server-only (service_role). Atomically claims a short refresh lease and returns the current Vault credential pair only to the winning claimant.';

-- ---------------------------------------------------------------------------
-- Complete a successful refresh atomically
-- ---------------------------------------------------------------------------
create or replace function public.complete_connection_token_refresh(
  p_connection_id uuid,
  p_claim_id uuid,
  p_expected_version bigint,
  p_token_payload jsonb,
  p_reason text default 'proactive',
  p_api_version text default null
)
returns table (result text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.sp_shopify_connections%rowtype;
  v_access_expires_at timestamptz;
  v_refresh_expires_at timestamptz;
  v_vault_payload jsonb;
  v_metadata jsonb;
  v_now timestamptz := now();
begin
  if p_connection_id is null or p_claim_id is null or p_expected_version is null then
    raise exception 'complete_connection_token_refresh: connection, claim, and version are required';
  end if;
  if p_reason is null or p_reason not in ('proactive', 'expired', 'forced') then
    raise exception 'complete_connection_token_refresh: invalid refresh reason';
  end if;
  if p_api_version is not null and p_api_version !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'complete_connection_token_refresh: invalid api version';
  end if;
  if p_token_payload is null or jsonb_typeof(p_token_payload) <> 'object' then
    raise exception 'complete_connection_token_refresh: token payload must be a JSON object';
  end if;
  if jsonb_typeof(p_token_payload->'access_token') is distinct from 'string'
     or coalesce(p_token_payload->>'access_token', '') = '' then
    raise exception 'complete_connection_token_refresh: access_token is required';
  end if;
  if jsonb_typeof(p_token_payload->'refresh_token') is distinct from 'string'
     or coalesce(p_token_payload->>'refresh_token', '') = '' then
    raise exception 'complete_connection_token_refresh: refresh_token is required';
  end if;
  if jsonb_typeof(p_token_payload->'expires_in') is distinct from 'number'
     or coalesce((p_token_payload->>'expires_in')::numeric, 0) <= 0 then
    raise exception 'complete_connection_token_refresh: expires_in must be positive';
  end if;
  if p_token_payload ? 'refresh_token_expires_in' then
    if jsonb_typeof(p_token_payload->'refresh_token_expires_in') is distinct from 'number'
       or coalesce((p_token_payload->>'refresh_token_expires_in')::numeric, 0) <= 0 then
      raise exception 'complete_connection_token_refresh: refresh_token_expires_in must be positive';
    end if;
  end if;

  select * into v_connection
  from public.sp_shopify_connections
  where id = p_connection_id
  for update;

  if not found then
    return query select 'not_found'::text;
    return;
  end if;
  if v_connection.status is distinct from 'connected' then
    return query select 'not_connected'::text;
    return;
  end if;
  if v_connection.credential_version is distinct from p_expected_version
     or v_connection.refresh_claim_id is distinct from p_claim_id
     or v_connection.refresh_claim_expires_at is null
     or v_connection.refresh_claim_expires_at <= v_now then
    return query select 'stale'::text;
    return;
  end if;
  if v_connection.vault_secret_id is null
     or not exists (select 1 from vault.secrets s where s.id = v_connection.vault_secret_id) then
    raise exception 'complete_connection_token_refresh: Vault secret is missing';
  end if;

  v_access_expires_at := v_now +
    ((p_token_payload->>'expires_in')::double precision * interval '1 second');
  if p_token_payload ? 'refresh_token_expires_in' then
    v_refresh_expires_at := v_now +
      ((p_token_payload->>'refresh_token_expires_in')::double precision * interval '1 second');
  end if;

  v_vault_payload := jsonb_build_object(
    'access_token', p_token_payload->'access_token',
    'refresh_token', p_token_payload->'refresh_token'
  );

  -- Vault update, metadata update, generation bump, and event insert all run
  -- in this one transaction. Any exception rolls every write back together.
  perform vault.update_secret(
    v_connection.vault_secret_id,
    new_secret => v_vault_payload::text
  );

  update public.sp_shopify_connections
     set access_token_expires_at = v_access_expires_at,
         refresh_token_expires_at = case
           when p_token_payload ? 'refresh_token_expires_in' then v_refresh_expires_at
           else refresh_token_expires_at
         end,
         refresh_claim_id = null,
         refresh_claim_expires_at = null,
         credential_version = credential_version + 1,
         last_verified_at = v_now,
         updated_at = v_now
   where id = p_connection_id;

  v_metadata := jsonb_build_object('reason', p_reason);
  if p_api_version is not null then
    v_metadata := v_metadata || jsonb_build_object('api_version', p_api_version);
  end if;

  insert into public.sp_shopify_connection_events (
    connection_id, project_id, event_type, metadata
  ) values (
    v_connection.id,
    v_connection.project_id,
    'token_refreshed',
    v_metadata
  );

  return query select 'completed'::text;
end;
$$;

comment on function public.complete_connection_token_refresh(uuid, uuid, bigint, jsonb, text, text) is
  'Server-only (service_role). Rotates the Vault token pair, expiry metadata, credential generation, and exactly one token_refreshed event atomically under a claim guard.';

-- ---------------------------------------------------------------------------
-- Release a transiently failed claim without changing connection state
-- ---------------------------------------------------------------------------
create or replace function public.release_connection_token_refresh(
  p_connection_id uuid,
  p_claim_id uuid
)
returns table (result text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.sp_shopify_connections%rowtype;
begin
  if p_connection_id is null or p_claim_id is null then
    raise exception 'release_connection_token_refresh: connection and claim are required';
  end if;

  select * into v_connection
  from public.sp_shopify_connections
  where id = p_connection_id
  for update;

  if not found then
    return query select 'not_found'::text;
    return;
  end if;
  if v_connection.refresh_claim_id is null then
    return query select 'already_released'::text;
    return;
  end if;
  if v_connection.refresh_claim_id is distinct from p_claim_id then
    return query select 'not_owner'::text;
    return;
  end if;

  update public.sp_shopify_connections
     set refresh_claim_id = null,
         refresh_claim_expires_at = null,
         updated_at = now()
   where id = p_connection_id;

  return query select 'released'::text;
end;
$$;

comment on function public.release_connection_token_refresh(uuid, uuid) is
  'Server-only (service_role). Releases only the caller-owned transient refresh lease; never changes status or emits an event.';

-- ---------------------------------------------------------------------------
-- Terminal refresh failure transition
-- ---------------------------------------------------------------------------
create or replace function public.mark_connection_reauth_required(
  p_connection_id uuid,
  p_claim_id uuid,
  p_expected_version bigint,
  p_reason text default 'invalid_refresh_token'
)
returns table (result text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.sp_shopify_connections%rowtype;
  v_now timestamptz := now();
begin
  if p_connection_id is null or p_claim_id is null or p_expected_version is null then
    raise exception 'mark_connection_reauth_required: connection, claim, and version are required';
  end if;
  if p_reason is null or p_reason not in (
    'invalid_refresh_token', 'expired_refresh_token',
    'revoked_refresh_token', 'missing_refresh_token'
  ) then
    raise exception 'mark_connection_reauth_required: invalid reason';
  end if;

  select * into v_connection
  from public.sp_shopify_connections
  where id = p_connection_id
  for update;

  if not found then
    return query select 'not_found'::text;
    return;
  end if;
  if v_connection.status = 'reauth_required' then
    return query select 'already_reauth_required'::text;
    return;
  end if;
  if v_connection.status is distinct from 'connected' then
    return query select 'not_connected'::text;
    return;
  end if;
  if v_connection.credential_version is distinct from p_expected_version
     or v_connection.refresh_claim_id is distinct from p_claim_id
     or v_connection.refresh_claim_expires_at is null
     or v_connection.refresh_claim_expires_at <= v_now then
    return query select 'stale'::text;
    return;
  end if;

  if v_connection.vault_secret_id is not null then
    delete from vault.secrets where id = v_connection.vault_secret_id;
  end if;

  update public.sp_shopify_connections
     set status = 'reauth_required',
         vault_secret_id = null,
         refresh_claim_id = null,
         refresh_claim_expires_at = null,
         last_verified_at = v_now,
         updated_at = v_now
   where id = p_connection_id;

  insert into public.sp_shopify_connection_events (
    connection_id, project_id, event_type, metadata
  ) values (
    v_connection.id,
    v_connection.project_id,
    'reauth_required',
    jsonb_build_object(
      'reason', p_reason,
      'previous_status', 'connected'
    )
  );

  return query select 'completed'::text;
end;
$$;

comment on function public.mark_connection_reauth_required(uuid, uuid, bigint, text) is
  'Server-only (service_role). Idempotently transitions a claimed connected row to reauth_required, deletes invalid Vault material, and emits exactly one event.';

-- ---------------------------------------------------------------------------
-- Explicit least-privilege grants
-- ---------------------------------------------------------------------------
revoke execute on function public.get_connection_tokens_by_id(uuid)
  from public, anon, authenticated;
revoke execute on function public.claim_connection_token_refresh(uuid, uuid, bigint, integer)
  from public, anon, authenticated;
revoke execute on function public.complete_connection_token_refresh(uuid, uuid, bigint, jsonb, text, text)
  from public, anon, authenticated;
revoke execute on function public.release_connection_token_refresh(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.mark_connection_reauth_required(uuid, uuid, bigint, text)
  from public, anon, authenticated;
revoke execute on function public.store_connection_tokens(uuid, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.get_connection_tokens_by_id(uuid) to service_role;
grant execute on function public.claim_connection_token_refresh(uuid, uuid, bigint, integer) to service_role;
grant execute on function public.complete_connection_token_refresh(uuid, uuid, bigint, jsonb, text, text) to service_role;
grant execute on function public.release_connection_token_refresh(uuid, uuid) to service_role;
grant execute on function public.mark_connection_reauth_required(uuid, uuid, bigint, text) to service_role;
grant execute on function public.store_connection_tokens(uuid, text, jsonb) to service_role;
