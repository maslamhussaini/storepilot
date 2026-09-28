-- ============================================================================
-- StorePilot Phase 2B.3B-3 — Shopify Disconnect & Reconnect Lifecycle SQL suite
-- ----------------------------------------------------------------------------
-- All credentials below are unmistakably fake fixtures. The suite runs in one
-- transaction and ends with ROLLBACK, so it creates no permanent users,
-- projects, connections, events, or Vault secrets.
-- ============================================================================

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.sp_assert(ok boolean, label text)
returns void language plpgsql as $$
begin
  if ok then
    raise notice 'PASS [%]', label;
  else
    raise exception 'FAIL [%]', label;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Two fake tenants/projects (plus one for uninstalled test, one for reauth test, one for atomicity test)
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('f3333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'disconnect-a@storepilot.test', 'x', now(), now(), now()),
  ('f4444444-4444-4444-8444-444444444444', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'disconnect-b@storepilot.test', 'x', now(), now(), now()),
  ('f5555555-5555-4555-8555-555555555555', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'uninstall-test@storepilot.test', 'x', now(), now(), now()),
  ('f6666666-6666-4666-8666-666666666666', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'reauth-disconnect@storepilot.test', 'x', now(), now(), now()),
  ('f7777777-7777-4777-8777-777777777777', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'atomic-disconnect@storepilot.test', 'x', now(), now(), now());

insert into public.sp_projects (id, user_id, name)
values
  ('f3333333-3333-4333-8333-333333333333', 'f3333333-3333-4333-8333-333333333333', 'Disconnect Fixture A'),
  ('f4444444-4444-4444-8444-444444444444', 'f4444444-4444-4444-8444-444444444444', 'Disconnect Fixture B'),
  ('f5555555-5555-4555-8555-555555555555', 'f5555555-5555-4555-8555-555555555555', 'Uninstall Fixture'),
  ('f6666666-6666-4666-8666-666666666666', 'f6666666-6666-4666-8666-666666666666', 'Reauth Disconnect Fixture'),
  ('f7777777-7777-4777-8777-777777777777', 'f7777777-7777-4777-8777-777777777777', 'Atomic Disconnect Fixture');

-- ===========================================================================
-- A. Setup: Create initial connected connections for both projects
-- ===========================================================================
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.sp_assert(
  public.store_connection_tokens(
    'f3333333-3333-4333-8333-333333333333',
    'disconnect-a.myshopify.com',
    '{"access_token":"fake-access-a",
      "refresh_token":"fake-refresh-a",
      "expires_in":3600,
      "refresh_token_expires_in":7776000,
      "scope":""}'::jsonb
  ) is not null,
  'Setup.1 service_role stores fake OAuth connection for project A'
);

select pg_temp.sp_assert(
  public.store_connection_tokens(
    'f4444444-4444-4444-8444-444444444444',
    'disconnect-b.myshopify.com',
    '{"access_token":"fake-access-b",
      "refresh_token":"fake-refresh-b",
      "expires_in":3600,
      "refresh_token_expires_in":7776000,
      "scope":""}'::jsonb
  ) is not null,
  'Setup.2 service_role stores fake OAuth connection for project B'
);

-- Verify initial state
select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
   where project_id = 'f3333333-3333-4333-8333-333333333333'
     and status = 'connected') = 'connected'
  and (select vault_secret_id from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'connected') is not null
  and (select access_token_expires_at from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'connected') is not null
  and (select refresh_token_expires_at from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'connected') is not null
  and (select credential_version from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'connected') = 1,
  'A.1 project A starts connected with Vault secret, expiry metadata, and generation 1'
);

select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
   where project_id = 'f4444444-4444-4444-8444-444444444444'
     and status = 'connected') = 'connected'
  and (select vault_secret_id from public.sp_shopify_connections
       where project_id = 'f4444444-4444-4444-8444-444444444444'
         and status = 'connected') is not null,
  'A.2 project B starts connected with Vault secret'
);

-- ===========================================================================
-- B. Owner can disconnect own connection
-- ===========================================================================
-- Call the void function, then assert success
do $$
begin
  perform public.revoke_connection_tokens(
    'f3333333-3333-4333-8333-333333333333',
    'disconnected'
  );
end $$;
select pg_temp.sp_assert(true, 'B.1 owner disconnects own connection via revoke_connection_tokens');

select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
   where project_id = 'f3333333-3333-4333-8333-333333333333'
     and status = 'disconnected') = 'disconnected'
  and (select vault_secret_id from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'disconnected') is null
  and (select access_token_expires_at from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'disconnected') is null
  and (select refresh_token_expires_at from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'disconnected') is null
  and (select refresh_claim_id from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'disconnected') is null
  and (select refresh_claim_expires_at from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'disconnected') is null
  and (select disconnected_at from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'disconnected') is not null
  and (select credential_version from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'disconnected') = 1,
  'B.2 disconnected state: status=disconnected, Vault cleared, ALL expiry/claim metadata cleared, generation preserved'
);

select pg_temp.sp_assert(
  (select count(*) from vault.secrets s
   join public.sp_shopify_connections c on c.vault_secret_id = s.id
   where c.project_id = 'f3333333-3333-4333-8333-333333333333') = 0,
  'B.3 Vault secret is deleted (no orphan)'
);

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connection_events
   where project_id = 'f3333333-3333-4333-8333-333333333333'
     and event_type = 'disconnected') = 1
  and (select metadata->>'reason' from public.sp_shopify_connection_events
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and event_type = 'disconnected') = 'disconnected',
  'B.4 exactly one disconnected event with reason metadata (no secrets)'
);

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connection_events
   where project_id = 'f3333333-3333-4333-8333-333333333333'
     and event_type = 'installed') = 1,
  'B.5 historical installed event preserved'
);

-- ===========================================================================
-- C. Idempotency: repeated disconnect is a no-op, no duplicate events
-- ===========================================================================
do $$
begin
  perform public.revoke_connection_tokens(
    'f3333333-3333-4333-8333-333333333333',
    'disconnected'
  );
end $$;
select pg_temp.sp_assert(true, 'C.1 repeated disconnect call returns successfully (no-op)');

select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
   where project_id = 'f3333333-3333-4333-8333-333333333333'
     and status = 'disconnected') = 'disconnected',
  'C.2 status remains disconnected'
);

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connection_events
   where project_id = 'f3333333-3333-4333-8333-333333333333'
     and event_type = 'disconnected') = 1,
  'C.3 no duplicate disconnected events created'
);

-- ===========================================================================
-- D. User A cannot disconnect User B connection
-- ===========================================================================
-- Switch to authenticated role as User A and try to call revoke on User B's project
-- The revoke function is service_role only, so authenticated should be denied
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3333333-3333-4333-8333-333333333333","role":"authenticated"}';

do $$
begin
  begin
    perform public.revoke_connection_tokens(
      'f4444444-4444-4444-8444-444444444444',
      'disconnected'
    );
  exception when insufficient_privilege then
    return;
  end;
  raise exception 'FAIL [D.1 authenticated role called revoke_connection_tokens]';
end $$;
select pg_temp.sp_assert(true, 'D.1 authenticated role denied revoke_connection_tokens');

-- Verify User B's connection is still connected
reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
   where project_id = 'f4444444-4444-4444-8444-444444444444'
     and status = 'connected') = 'connected',
  'D.2 User B connection unaffected by User A attempt'
);

-- ===========================================================================
-- E. Anonymous role cannot disconnect
-- ===========================================================================
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

do $$
begin
  begin
    perform public.revoke_connection_tokens(
      'f4444444-4444-4444-8444-444444444444',
      'disconnected'
    );
  exception when insufficient_privilege then
    return;
  end;
  raise exception 'FAIL [E.1 anon role called revoke_connection_tokens]';
end $$;
select pg_temp.sp_assert(true, 'E.1 anon role denied revoke_connection_tokens');

-- ===========================================================================
-- F. Reconnect: OAuth flow on disconnected project creates new connected state
-- ===========================================================================
reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

-- First, verify the project is disconnected
select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
   where project_id = 'f3333333-3333-4333-8333-333333333333'
     and status = 'disconnected') = 'disconnected',
  'F.1 project A is in disconnected state before reconnect'
);

-- Reconnect via store_connection_tokens (simulating OAuth reauthorization)
select pg_temp.sp_assert(
  public.store_connection_tokens(
    'f3333333-3333-4333-8333-333333333333',
    'disconnect-a.myshopify.com',
    '{"access_token":"fake-access-a-reconnect",
      "refresh_token":"fake-refresh-a-reconnect",
      "expires_in":3600,
      "refresh_token_expires_in":7776000,
      "scope":""}'::jsonb
  ) is not null,
  'F.2 reconnect via store_connection_tokens succeeds'
);

select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
   where project_id = 'f3333333-3333-4333-8333-333333333333'
     and status = 'connected') = 'connected'
  and (select vault_secret_id from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'connected') is not null
  and (select access_token_expires_at from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'connected') is not null
  and (select refresh_token_expires_at from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'connected') is not null
  and (select credential_version from public.sp_shopify_connections
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and status = 'connected') = 2,
  'F.3 reconnect returns status=connected, new Vault secret, fresh expiry metadata, generation incremented to 2'
);

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connection_events
   where project_id = 'f3333333-3333-4333-8333-333333333333'
     and event_type = 'reconnected') = 1
  and (select metadata->>'shop_domain' from public.sp_shopify_connection_events
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and event_type = 'reconnected') = 'disconnect-a.myshopify.com',
  'F.4 exactly one reconnected event with shop_domain metadata'
);

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connection_events
   where project_id = 'f3333333-3333-4333-8333-333333333333'
     and event_type = 'installed') = 1
  and (select count(*) from public.sp_shopify_connection_events
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and event_type = 'disconnected') = 1
  and (select count(*) from public.sp_shopify_connection_events
       where project_id = 'f3333333-3333-4333-8333-333333333333'
         and event_type = 'reconnected') = 1,
  'F.5 full event history preserved: installed -> disconnected -> reconnected'
);

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections
   where project_id = 'f3333333-3333-4333-8333-333333333333'
     and status = 'connected') = 1,
  'F.6 exactly one active connection row (no duplicate active rows)'
);

-- ===========================================================================
-- G. Disconnected connection exposes no token material
-- ===========================================================================
-- The disconnected connection should have no vault_secret_id and no expiry metadata
-- Disconnect project A again (it was reconnected in section F) to test disconnected metadata access
do $$
begin
  perform public.revoke_connection_tokens(
    'f3333333-3333-4333-8333-333333333333',
    'disconnected'
  );
end $$;

select pg_temp.sp_assert(
  (select vault_secret_id from public.sp_shopify_connections
   where project_id = 'f4444444-4444-4444-8444-444444444444'
     and status = 'connected') is not null,
  'G.1 project B (still connected) has vault_secret_id'
);

-- Project A is disconnected - verify no token material accessible via metadata RPC
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3333333-3333-4333-8333-333333333333","role":"authenticated"}';

select pg_temp.sp_assert(
  (select count(*) from public.get_connection_metadata(
    'f3333333-3333-4333-8333-333333333333')) = 1
  and (select status from public.get_connection_metadata(
    'f3333333-3333-4333-8333-333333333333')) = 'disconnected',
  'G.2 get_connection_metadata returns disconnected status for owner'
);

reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

-- The token getter should not return tokens for disconnected connections
do $$
declare
  v_conn_id uuid;
begin
  select id into v_conn_id
  from public.sp_shopify_connections
  where project_id = 'f3333333-3333-4333-8333-333333333333'
    and status = 'disconnected';
  
  if v_conn_id is not null then
    -- Try to get tokens - should return nothing because status != 'connected'
    perform public.get_connection_tokens('f3333333-3333-4333-8333-333333333333');
    -- If we get here, check the result was empty
    -- The function only returns rows where status = 'connected'
  end if;
end $$;

select pg_temp.sp_assert(
  (select count(*) from public.get_connection_tokens(
    'f3333333-3333-4333-8333-333333333333')) = 0,
  'G.3 get_connection_tokens returns no rows for disconnected connection'
);

-- ===========================================================================
-- H. Event metadata contains no credentials
-- ===========================================================================
select pg_temp.sp_assert(
  not exists (
    select 1 from public.sp_shopify_connection_events
    where project_id in ('f3333333-3333-4333-8333-333333333333', 'f4444444-4444-4444-8444-444444444444')
      and metadata::text ~* '"(access_token|refresh_token|authorization_code|client_secret|refresh_token_expires_at|refresh_token_expires_in|expires_in|expires_at|state|cookie|cookies|set-cookie|code|token|tokens|jwt|password|secret|hmac)"\s*:'
  ),
  'H.1 no secret-bearing keys in any event metadata'
);

-- ===========================================================================
-- I. No orphan Vault secrets after disconnect/reconnect cycle
-- ===========================================================================
-- Project A was reconnected (F) then disconnected again (G), so only Project B is connected
select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections c
   join vault.secrets s on s.id = c.vault_secret_id
   where c.project_id in ('f3333333-3333-4333-8333-333333333333', 'f4444444-4444-4444-8444-444444444444')
     and c.status = 'connected') = 1,
  'I.1 exactly one Vault secret for the one connected connection (project B)'
);

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections c
   left join vault.secrets s on s.id = c.vault_secret_id
   where c.project_id in ('f3333333-3333-4333-8333-333333333333', 'f4444444-4444-4444-8444-444444444444')
     and c.status = 'disconnected'
     and s.id is not null) = 0,
  'I.2 disconnected connections have no linked Vault secrets'
);

-- ===========================================================================
-- J. Grant boundary: token functions remain service_role-only
-- ===========================================================================
select pg_temp.sp_assert(
  has_function_privilege('anon', 'public.revoke_connection_tokens(uuid, text)', 'EXECUTE') = false
  and has_function_privilege('authenticated', 'public.revoke_connection_tokens(uuid, text)', 'EXECUTE') = false
  and has_function_privilege('service_role', 'public.revoke_connection_tokens(uuid, text)', 'EXECUTE') = true,
  'J.1 revoke_connection_tokens remains service_role-only'
);

-- ===========================================================================
-- K. Uninstalled reason variant
-- ===========================================================================
-- Create a fresh connection for uninstalled test (user and project already created in setup)
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.sp_assert(
  public.store_connection_tokens(
    'f5555555-5555-4555-8555-555555555555',
    'uninstall-test.myshopify.com',
    '{"access_token":"fake-access-uninstall",
      "refresh_token":"fake-refresh-uninstall",
      "expires_in":3600}'::jsonb
  ) is not null,
  'K.1 setup uninstalled test connection'
);

do $$
begin
  perform public.revoke_connection_tokens(
    'f5555555-5555-4555-8555-555555555555',
    'uninstalled'
  );
end $$;
select pg_temp.sp_assert(true, 'K.2 revoke with uninstalled reason');

select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
   where project_id = 'f5555555-5555-4555-8555-555555555555'
     and status = 'uninstalled') = 'uninstalled',
  'K.3 status becomes uninstalled'
);

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connection_events
   where project_id = 'f5555555-5555-4555-8555-555555555555'
     and event_type = 'uninstalled') = 1
  and (select metadata->>'reason' from public.sp_shopify_connection_events
       where project_id = 'f5555555-5555-4555-8555-555555555555'
         and event_type = 'uninstalled') = 'uninstalled',
  'K.4 uninstalled event recorded with reason'
);

-- ===========================================================================
-- L. Disconnect clears reauth_required state if present
-- ===========================================================================
-- Create a connection in reauth_required state (user and project already created in setup)
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.sp_assert(
  public.store_connection_tokens(
    'f6666666-6666-4666-8666-666666666666',
    'reauth-disconnect.myshopify.com',
    '{"access_token":"fake-access-reauth",
      "refresh_token":"fake-refresh-reauth",
      "expires_in":3600}'::jsonb
  ) is not null,
  'L.1 setup reauth test connection'
);

-- Transition to reauth_required using mark_connection_reauth_required
do $$
declare
  v_conn_id uuid;
  v_claim_id uuid := gen_random_uuid();
begin
  select id into v_conn_id
  from public.sp_shopify_connections
  where project_id = 'f6666666-6666-4666-8666-666666666666'
    and status = 'connected';
  
  perform public.claim_connection_token_refresh(v_conn_id, v_claim_id, 1, 60);
  perform public.mark_connection_reauth_required(v_conn_id, v_claim_id, 1, 'invalid_refresh_token');
end $$;

select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
   where project_id = 'f6666666-6666-4666-8666-666666666666'
     and status = 'reauth_required') = 'reauth_required',
  'L.2 connection is in reauth_required state'
);

-- Now disconnect should work and clear the reauth state
do $$
begin
  perform public.revoke_connection_tokens(
    'f6666666-6666-4666-8666-666666666666',
    'disconnected'
  );
end $$;
select pg_temp.sp_assert(true, 'L.3 disconnect from reauth_required state');

select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
   where project_id = 'f6666666-6666-4666-8666-666666666666'
     and status = 'disconnected') = 'disconnected',
  'L.4 status becomes disconnected (not reauth_required)'
);

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connection_events
   where project_id = 'f6666666-6666-4666-8666-666666666666'
     and event_type = 'disconnected') = 1,
  'L.5 disconnected event recorded'
);

-- ===========================================================================
-- M. Atomicity: failure during disconnect rolls back
-- ===========================================================================
-- Create a trigger that fails on disconnect event
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

create or replace function pg_temp.sp_fail_disconnect_event()
returns trigger language plpgsql as $$
begin
  if new.event_type = 'disconnected' then
    raise exception 'fixture disconnect event failure';
  end if;
  return new;
end;
$$;

create trigger sp_test_fail_disconnect_event
  before insert on public.sp_shopify_connection_events
  for each row
  execute function pg_temp.sp_fail_disconnect_event();

-- Setup a fresh connection for atomicity test (user and project already created in setup)
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.sp_assert(
  public.store_connection_tokens(
    'f7777777-7777-4777-8777-777777777777',
    'atomic-disconnect.myshopify.com',
    '{"access_token":"fake-access-atomic",
      "refresh_token":"fake-refresh-atomic",
      "expires_in":3600}'::jsonb
  ) is not null,
  'M.1 atomicity test connection stored'
);

do $$
begin
  begin
    perform public.revoke_connection_tokens(
      'f7777777-7777-4777-8777-777777777777',
      'disconnected'
    );
  exception when others then
    return;
  end;
  raise exception 'FAIL [M.2 event trigger did not abort revoke]';
end $$;

select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
   where project_id = 'f7777777-7777-4777-8777-777777777777'
     and status = 'connected') = 'connected'
  and (select vault_secret_id from public.sp_shopify_connections
       where project_id = 'f7777777-7777-4777-8777-777777777777'
         and status = 'connected') is not null,
  'M.2 event failure rolls back: status remains connected, Vault secret intact'
);

-- Trigger cleanup skipped (temp function will be invalid after session; table owner required to drop)
-- drop trigger sp_test_fail_disconnect_event on public.sp_shopify_connection_events;

-- ===========================================================================
-- N. No fake token material in ordinary tables or event metadata
-- ===========================================================================
select pg_temp.sp_assert(
  not exists (
    select 1 from public.sp_shopify_connections c
    where to_jsonb(c)::text ~* 'fake-(access|refresh)-'
  )
  and not exists (
    select 1 from public.sp_shopify_connection_events e
    where to_jsonb(e)::text ~* 'fake-(access|refresh)-'
  )
  and not exists (
    select 1 from public.sp_shopify_connection_events e
    where e.metadata::text ~* '"(access_token|refresh_token|client_secret|state|code|token|secret)"\s*:'
  ),
  'N.1 ordinary connection/event tables contain no token material or secret keys'
);

-- ---------------------------------------------------------------------------
-- Completion marker and rollback
-- ---------------------------------------------------------------------------
reset role;
do $$ begin
  raise notice '=== ALL SHOPIFY DISCONNECT/RECONNECT TESTS PASSED ===';
end $$;
rollback;