-- ============================================================================
-- StorePilot Phase 2B.3B-3 — Fix Reconnect Generation Increment
-- ----------------------------------------------------------------------------
-- When reconnecting after a disconnect, store_connection_tokens should UPDATE
-- the existing disconnected/reauth row instead of INSERTing a new one, so that
-- credential_version increments properly (preserving audit history).
-- ============================================================================

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

  -- First, try to update an existing connected row (normal refresh path)
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

-- If no connected row, try to update a disconnected/reauth row (reconnect path)
  -- This preserves the row history and increments credential_version
  if v_connection_id is null then
    update public.sp_shopify_connections
       set shop_domain = v_shop_domain,
           granted_scopes = v_scopes,
           access_token_expires_at = v_access_token_expires_at,
           refresh_token_expires_at = v_refresh_token_expires_at,
           disconnected_at = null,
           status = 'connected',
           last_verified_at = v_now,
           refresh_claim_id = null,
           refresh_claim_expires_at = null,
           credential_version = credential_version + 1,
           updated_at = v_now
      where id = (
        select id from public.sp_shopify_connections
        where project_id = p_project_id
          and status in ('disconnected', 'reauth_required')
        order by updated_at desc
        limit 1
      )
  returning id, vault_secret_id into v_connection_id, v_vault_secret_id;

    if v_connection_id is not null then
      v_updated := true;
    end if;
  end if;

  -- If still no row, insert a new connection (first-time install)
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
  'Server-only (service_role). Stores or updates Shopify OAuth tokens in Vault. On reconnect (after disconnect/reauth), updates the existing row and increments credential_version. Emits "installed" or "reconnected" event. EXECUTE granted to service_role exclusively.';

-- Grants (re-stated for audit)
revoke execute on function public.store_connection_tokens(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.store_connection_tokens(uuid, text, jsonb) to service_role;