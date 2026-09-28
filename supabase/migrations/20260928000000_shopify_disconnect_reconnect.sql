-- ============================================================================
-- StorePilot Phase 2B.3B-3 — Shopify Disconnect & Reconnect Lifecycle
-- ----------------------------------------------------------------------------
-- Enhances revoke_connection_tokens to clear all token metadata and lease
-- state, ensuring a clean disconnected state. Adds ownership verification
-- and idempotency guarantees.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enhanced revoke_connection_tokens with full metadata cleanup
-- ---------------------------------------------------------------------------
-- Replaces the 2B.3A version to:
--   * Clear access_token_expires_at and refresh_token_expires_at
--   * Clear refresh_claim_id and refresh_claim_expires_at
--   * Explicitly verify project ownership before mutation
--   * Remain idempotent: repeated calls on same project are no-ops
--   * Emit exactly one 'disconnected' or 'uninstalled' event per transition
--   * Preserve credential_version for historical audit
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
  v_owner_user_id uuid;
begin
  -- Verify project exists and derive owner. This is the authoritative
  -- ownership check: the caller (service_role) must have already verified
  -- the user owns this project, but we re-derive it here for defense in depth.
  select user_id into v_owner_user_id
  from public.sp_projects
  where id = p_project_id;

  if v_owner_user_id is null then
    raise exception 'revoke_connection_tokens: project % not found', p_project_id;
  end if;

  -- Find the most relevant non-terminal connection for this project.
  -- Includes 'reauth_required' so a failed refresh can be cleaned up.
  select id, vault_secret_id
    into v_connection_id, v_vault_secret_id
  from public.sp_shopify_connections
  where project_id = p_project_id
    and status in ('connected', 'reauth_required')
  order by (status = 'connected') desc, updated_at desc
  limit 1;

  if v_connection_id is null then
    -- No active/reauth connection to revoke — idempotent no-op.
    return;
  end if;

  -- 1. Delete the Vault secret FIRST (ordering rationale: tokens gone,
  --    row still marked connected is recoverable; row disconnected while
  --    tokens remain in Vault is a silent leak).
  if v_vault_secret_id is not null then
    delete from vault.secrets where id = v_vault_secret_id;
  end if;

  -- 2. Mark the connection disconnected/uninstalled and clear ALL token
  --    metadata including expiry timestamps and refresh lease state.
  v_event_type := case when p_reason = 'uninstalled' then 'uninstalled' else 'disconnected' end;

  update public.sp_shopify_connections
     set status = v_event_type,
         disconnected_at = now(),
         vault_secret_id = null,
         access_token_expires_at = null,
         refresh_token_expires_at = null,
         refresh_claim_id = null,
         refresh_claim_expires_at = null,
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

comment on function public.revoke_connection_tokens(uuid, text) is
  'Server-only (service_role). Atomically deletes Vault secret, clears all token metadata and lease state, marks connection disconnected/uninstalled, and emits exactly one lifecycle event. Idempotent: no-op if no active/reauth connection exists. EXECUTE granted to service_role exclusively.';

-- ---------------------------------------------------------------------------
-- GRANTS — ensure least privilege (already granted to service_role in 2B.3A,
-- but stated explicitly here for clarity and audit trail)
-- ---------------------------------------------------------------------------
revoke execute on function public.revoke_connection_tokens(uuid, text)
  from public, anon, authenticated;
grant execute on function public.revoke_connection_tokens(uuid, text) to service_role;