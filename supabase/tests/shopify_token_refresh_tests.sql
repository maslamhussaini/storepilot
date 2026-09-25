-- ============================================================================
-- StorePilot Phase 2B.3B-2 — Shopify token refresh lifecycle SQL suite
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
-- Two fake tenants/projects
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('f1111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'refresh-a@storepilot.test', 'x', now(), now(), now()),
  ('f2222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'refresh-b@storepilot.test', 'x', now(), now(), now());

insert into public.sp_projects (id, user_id, name)
values
  ('f1111111-1111-4111-8111-111111111111', 'f1111111-1111-4111-8111-111111111111', 'Refresh Fixture A'),
  ('f2222222-2222-4222-8222-222222222222', 'f2222222-2222-4222-8222-222222222222', 'Refresh Fixture B');

-- ---------------------------------------------------------------------------
-- Initial OAuth-shaped fake connection through the existing server-only path
-- ---------------------------------------------------------------------------
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.sp_assert(
  public.store_connection_tokens(
    'f1111111-1111-4111-8111-111111111111',
    'refresh-fixture.myshopify.com',
    '{"access_token":"fake-access-initial",
      "refresh_token":"fake-refresh-initial",
      "expires_in":3600,
      "refresh_token_expires_in":7776000,
      "scope":""}'::jsonb
  ) is not null,
  'Setup.1 service_role stores a fake OAuth-shaped connection'
);

-- ===========================================================================
-- A-C. Initial read, claim, and successful rotation
-- ===========================================================================
select pg_temp.sp_assert(
  (select count(*) from public.get_connection_tokens_by_id(
    (select id from public.sp_shopify_connections
     where project_id = 'f1111111-1111-4111-8111-111111111111')
  )) = 1
  and (select access_token
       from public.get_connection_tokens_by_id(
         (select id from public.sp_shopify_connections
          where project_id = 'f1111111-1111-4111-8111-111111111111')
       )) = 'fake-access-initial'
  and (select refresh_token
       from public.get_connection_tokens_by_id(
         (select id from public.sp_shopify_connections
          where project_id = 'f1111111-1111-4111-8111-111111111111')
       )) = 'fake-refresh-initial'
  and (select credential_version
       from public.get_connection_tokens_by_id(
         (select id from public.sp_shopify_connections
          where project_id = 'f1111111-1111-4111-8111-111111111111')
       )) = 1,
  'A.1 trusted read returns the fake credential pair and generation'
);

select pg_temp.sp_assert(
  (select claim_result
   from public.claim_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 60
   )) = 'claimed',
  'B.1 first claimant wins the refresh lease'
);

select pg_temp.sp_assert(
  (select claim_result
   from public.claim_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, 60
   )) = 'already_claimed',
  'B.2 second claimant cannot steal an active lease'
);

select pg_temp.sp_assert(
  (select result
   from public.complete_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
     1,
     '{"access_token":"fake-access-rotated",
       "refresh_token":"fake-refresh-rotated",
       "expires_in":3600,
       "refresh_token_expires_in":7776000}'::jsonb,
     'proactive',
     '2026-07'
   )) = 'completed',
  'C.1 valid refresh completes under the claim guard'
);

select pg_temp.sp_assert(
  (select credential_version
   from public.sp_shopify_connections
   where project_id = 'f1111111-1111-4111-8111-111111111111'
     and status = 'connected') = 2
  and (select access_token
       from public.get_connection_tokens_by_id(
         (select id from public.sp_shopify_connections
          where project_id = 'f1111111-1111-4111-8111-111111111111')
       )) = 'fake-access-rotated'
  and (select refresh_token
       from public.get_connection_tokens_by_id(
         (select id from public.sp_shopify_connections
          where project_id = 'f1111111-1111-4111-8111-111111111111')
       )) = 'fake-refresh-rotated'
  and (select access_token_expires_at
       from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111'
         and status = 'connected') > now()
  and (select refresh_claim_id
       from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111'
         and status = 'connected') is null
  and (select count(*)
       from public.sp_shopify_connection_events
       where project_id = 'f1111111-1111-4111-8111-111111111111'
         and event_type = 'token_refreshed') = 1,
  'C.2 Vault rotation, expiry metadata, generation, and event are consistent'
);

-- ===========================================================================
-- D. OAuth reauthorization invalidates an in-flight refresh
-- ===========================================================================
select pg_temp.sp_assert(
  (select claim_result
   from public.claim_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 2, 60
   )) = 'claimed',
  'D.1 a later refresh attempt can claim the new generation'
);

select public.store_connection_tokens(
  'f1111111-1111-4111-8111-111111111111',
  'refresh-fixture.myshopify.com',
  '{"access_token":"fake-access-oauth",
    "refresh_token":"fake-refresh-oauth",
    "expires_in":3600,
    "refresh_token_expires_in":7776000}'::jsonb
);

select pg_temp.sp_assert(
  (select result
   from public.complete_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
     2,
     '{"access_token":"fake-access-stale",
       "refresh_token":"fake-refresh-stale",
       "expires_in":3600}'::jsonb,
     'proactive', '2026-07'
   )) = 'stale',
  'D.2 stale refresh cannot complete after OAuth increments the generation'
);

select pg_temp.sp_assert(
  (select credential_version
   from public.sp_shopify_connections
   where project_id = 'f1111111-1111-4111-8111-111111111111'
     and status = 'connected') = 3
  and (select access_token
       from public.get_connection_tokens_by_id(
         (select id from public.sp_shopify_connections
          where project_id = 'f1111111-1111-4111-8111-111111111111')
       )) = 'fake-access-oauth'
  and (select count(*)
       from public.sp_shopify_connection_events
       where project_id = 'f1111111-1111-4111-8111-111111111111'
         and event_type = 'token_refreshed') = 1,
  'D.3 OAuth result wins and no stale event is recorded'
);

-- ===========================================================================
-- E. Malformed response fails before persistence
-- ===========================================================================
select pg_temp.sp_assert(
  (select claim_result
   from public.claim_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 3, 60
   )) = 'claimed',
  'E.1 malformed-response test obtains a lease'
);

do $$
begin
  begin
    perform public.complete_connection_token_refresh(
      (select id from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111'),
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      3,
      '{"access_token":"fake-access-malformed","expires_in":3600}'::jsonb,
      'proactive', '2026-07'
    );
  exception when others then
    return;
  end;
  raise exception 'FAIL [E.2 malformed payload was accepted]';
end $$;

select pg_temp.sp_assert(
  (select credential_version
   from public.sp_shopify_connections
   where project_id = 'f1111111-1111-4111-8111-111111111111'
     and status = 'connected') = 3
  and (select access_token
       from public.get_connection_tokens_by_id(
         (select id from public.sp_shopify_connections
          where project_id = 'f1111111-1111-4111-8111-111111111111')
       )) = 'fake-access-oauth'
  and (select count(*)
       from public.sp_shopify_connection_events
       where project_id = 'f1111111-1111-4111-8111-111111111111'
         and event_type = 'token_refreshed') = 1,
  'E.2 malformed response leaves Vault, metadata, version, and events unchanged'
);

select public.release_connection_token_refresh(
  (select id from public.sp_shopify_connections
   where project_id = 'f1111111-1111-4111-8111-111111111111'),
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
);

-- ===========================================================================
-- F. Transient release leaves the connection connected
-- ===========================================================================
select pg_temp.sp_assert(
  (select claim_result
   from public.claim_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 3, 60
   )) = 'claimed',
  'F.1 transient-failure test obtains a lease'
);

select pg_temp.sp_assert(
  (select result
   from public.release_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
   )) = 'released'
  and (select status
       from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111'
         and status = 'connected') = 'connected'
  and (select count(*)
       from public.sp_shopify_connection_events
       where project_id = 'f1111111-1111-4111-8111-111111111111'
         and event_type = 'reauth_required') = 0,
  'F.2 releasing a transient claim preserves connected status and emits no reauth event'
);

-- ---------------------------------------------------------------------------
-- Phase 2B.3B-2B: claim-id scoping, clean release, and the claim-RPC contract
-- ---------------------------------------------------------------------------

-- F.3 setup: a fresh lease held by "this worker".
select pg_temp.sp_assert(
  (select claim_result
   from public.claim_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     '99999999-9999-4999-8999-999999999999', 3, 60
   )) = 'claimed',
  'F.3 stale-release scoping setup obtains a lease'
);

-- F.4 a stale worker releasing with a DIFFERENT claim id must be refused
--     (not_owner) and must leave the current worker's claim untouched.
select pg_temp.sp_assert(
  (select result
   from public.release_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     '88888888-8888-4888-8888-888888888888'
   )) = 'not_owner'
  and (select refresh_claim_id
       from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111')
      = '99999999-9999-4999-8999-999999999999',
  'F.4 a stale worker cannot release another worker''s claim'
);

-- F.5a the owner releases its own claim (mutation happens in its own
--      statement — later reads must use a NEW statement to observe it).
select pg_temp.sp_assert(
  (select result
   from public.release_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     '99999999-9999-4999-8999-999999999999'
   )) = 'released',
  'F.5 the owner releases its own claim'
);

-- F.5b residue check in a SEPARATE statement: no claim fields left behind,
--      status and generation untouched.
select pg_temp.sp_assert(
  (select refresh_claim_id
       from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111') is null
  and (select refresh_claim_expires_at
       from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111') is null
  and (select credential_version
       from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111') = 3
  and (select status
       from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111') = 'connected',
  'F.5b release leaves no claim residue and keeps status and generation'
);

-- F.6 contract guard: the claim RPC must project EXACTLY what the adapter
--     expects — credential_version present, lease columns ABSENT (PostgREST
--     omits undeclared OUT columns; indexing them was the 2B.3B-2A root
--     cause of persistence_failed with a leaked lease).
select pg_temp.sp_assert(
  pg_get_function_result(
    'public.claim_connection_token_refresh(uuid, uuid, bigint, integer)'::regprocedure
  ) like '%credential_version%'
  and pg_get_function_result(
    'public.claim_connection_token_refresh(uuid, uuid, bigint, integer)'::regprocedure
  ) not like '%refresh_claim%',
  'F.6 claim RPC returns the adapter contract: no lease columns in its projection'
);

-- ===========================================================================
-- G. Invalid refresh credential transitions once to reauth_required
-- ===========================================================================
select pg_temp.sp_assert(
  (select claim_result
   from public.claim_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     'ffffffff-ffff-4fff-8fff-ffffffffffff', 3, 60
   )) = 'claimed',
  'G.1 invalid-credential test obtains a lease'
);

select pg_temp.sp_assert(
  (select result
   from public.mark_connection_reauth_required(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     'ffffffff-ffff-4fff-8fff-ffffffffffff',
     3,
     'invalid_refresh_token'
   )) = 'completed',
  'G.2 invalid refresh credential transitions to reauth_required'
);

select pg_temp.sp_assert(
  (select status
   from public.sp_shopify_connections
   where project_id = 'f1111111-1111-4111-8111-111111111111'
     and status = 'reauth_required') = 'reauth_required'
  and (select vault_secret_id
       from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111'
         and status = 'reauth_required') is null
  and (select count(*)
       from vault.secrets s
       join public.sp_shopify_connections c on c.vault_secret_id = s.id
       where c.project_id = 'f1111111-1111-4111-8111-111111111111') = 0
  and (select count(*)
       from public.sp_shopify_connection_events
       where project_id = 'f1111111-1111-4111-8111-111111111111'
         and event_type = 'reauth_required') = 1,
  'G.3 invalid credential removes Vault material and preserves one reauth event'
);

select pg_temp.sp_assert(
  (select result
   from public.mark_connection_reauth_required(
     (select id from public.sp_shopify_connections
      where project_id = 'f1111111-1111-4111-8111-111111111111'),
     'ffffffff-ffff-4fff-8fff-ffffffffffff',
     3,
     'invalid_refresh_token'
   )) = 'already_reauth_required'
  and (select count(*)
       from public.sp_shopify_connection_events
       where project_id = 'f1111111-1111-4111-8111-111111111111'
         and event_type = 'reauth_required') = 1,
  'G.4 repeated invalid credential is idempotent and does not spam events'
);

-- ===========================================================================
-- H. Grant boundary and tenant isolation
-- ===========================================================================
select pg_temp.sp_assert(
  has_function_privilege('anon', 'public.get_connection_tokens_by_id(uuid)', 'EXECUTE') = false
  and has_function_privilege('authenticated', 'public.get_connection_tokens_by_id(uuid)', 'EXECUTE') = false
  and has_function_privilege('service_role', 'public.get_connection_tokens_by_id(uuid)', 'EXECUTE') = true
  and has_function_privilege('anon', 'public.claim_connection_token_refresh(uuid, uuid, bigint, integer)', 'EXECUTE') = false
  and has_function_privilege('authenticated', 'public.claim_connection_token_refresh(uuid, uuid, bigint, integer)', 'EXECUTE') = false
  and has_function_privilege('service_role', 'public.claim_connection_token_refresh(uuid, uuid, bigint, integer)', 'EXECUTE') = true
  and has_function_privilege('anon', 'public.complete_connection_token_refresh(uuid, uuid, bigint, jsonb, text, text)', 'EXECUTE') = false
  and has_function_privilege('authenticated', 'public.complete_connection_token_refresh(uuid, uuid, bigint, jsonb, text, text)', 'EXECUTE') = false
  and has_function_privilege('service_role', 'public.complete_connection_token_refresh(uuid, uuid, bigint, jsonb, text, text)', 'EXECUTE') = true
  and has_function_privilege('anon', 'public.mark_connection_reauth_required(uuid, uuid, bigint, text)', 'EXECUTE') = false
  and has_function_privilege('authenticated', 'public.mark_connection_reauth_required(uuid, uuid, bigint, text)', 'EXECUTE') = false
  and has_function_privilege('service_role', 'public.mark_connection_reauth_required(uuid, uuid, bigint, text)', 'EXECUTE') = true,
  'H.1 lifecycle RPCs remain service_role-only'
);

select pg_temp.sp_assert(
  has_table_privilege('anon', 'vault.secrets', 'SELECT') = false
  and has_table_privilege('authenticated', 'vault.secrets', 'SELECT') = false
  and has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT') = false
  and has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT') = false,
  'H.2 browser roles cannot read Vault metadata or decrypted secrets'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2222222-2222-4222-8222-222222222222","role":"authenticated"}';

select pg_temp.sp_assert(
  (select count(*) from public.sp_projects
   where id = 'f1111111-1111-4111-8111-111111111111') = 0
  and (select count(*) from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111') = 0
  and (select count(*) from public.get_connection_metadata(
       'f1111111-1111-4111-8111-111111111111')) = 0,
  'H.3 cross-tenant user cannot see the other project or connection metadata'
);

do $$
begin
  begin
    perform public.get_connection_tokens_by_id(
      (select id from public.sp_shopify_connections
       where project_id = 'f1111111-1111-4111-8111-111111111111')
    );
  exception when insufficient_privilege then
    return;
  end;
  raise exception 'FAIL [H.4 authenticated role called token getter]';
end $$;
select pg_temp.sp_assert(true, 'H.4 authenticated role is denied the raw token getter');

reset role;

-- ===========================================================================
-- I. No fake token material in ordinary tables or event metadata
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
  'I.1 ordinary connection/event tables contain no token material or secret keys'
);

-- ===========================================================================
-- J. Atomicity: a failure after Vault update rolls everything back
-- ===========================================================================
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.sp_assert(
  public.store_connection_tokens(
    'f2222222-2222-4222-8222-222222222222',
    'atomicity-fixture.myshopify.com',
    '{"access_token":"fake-access-atomic-initial",
      "refresh_token":"fake-refresh-atomic-initial",
      "expires_in":3600}'::jsonb
  ) is not null,
  'J.1 atomicity fixture connection is stored'
);

select pg_temp.sp_assert(
  (select claim_result
   from public.claim_connection_token_refresh(
     (select id from public.sp_shopify_connections
      where project_id = 'f2222222-2222-4222-8222-222222222222'),
     'abababab-abab-4bab-8bab-abababababab', 1, 60
   )) = 'claimed',
  'J.2 atomicity fixture obtains a refresh lease'
);

reset role;
create or replace function pg_temp.sp_fail_refresh_event()
returns trigger language plpgsql as $$
begin
  raise exception 'fixture event failure';
end;
$$;
create trigger sp_test_fail_refresh_event
  after insert on public.sp_shopify_connection_events
  for each row
  when (new.event_type = 'token_refreshed')
  execute function pg_temp.sp_fail_refresh_event();

set local role service_role;

do $$
begin
  begin
    perform public.complete_connection_token_refresh(
      (select id from public.sp_shopify_connections
       where project_id = 'f2222222-2222-4222-8222-222222222222'),
      'abababab-abab-4bab-8bab-abababababab',
      1,
      '{"access_token":"fake-access-atomic-rotated",
        "refresh_token":"fake-refresh-atomic-rotated",
        "expires_in":3600}'::jsonb,
      'proactive', '2026-07'
    );
  exception when others then
    return;
  end;
  raise exception 'FAIL [J.3 event trigger did not abort completion]';
end $$;

select pg_temp.sp_assert(
  (select credential_version
   from public.sp_shopify_connections
   where project_id = 'f2222222-2222-4222-8222-222222222222'
     and status = 'connected') = 1
  and (select access_token
       from public.get_connection_tokens_by_id(
         (select id from public.sp_shopify_connections
          where project_id = 'f2222222-2222-4222-8222-222222222222')
       )) = 'fake-access-atomic-initial'
  and (select count(*)
       from public.sp_shopify_connection_events
       where project_id = 'f2222222-2222-4222-8222-222222222222'
         and event_type = 'token_refreshed') = 0,
  'J.3 event failure rolls back Vault rotation, metadata, version, and event'
);

reset role;
drop trigger sp_test_fail_refresh_event on public.sp_shopify_connection_events;

-- ---------------------------------------------------------------------------
-- Completion marker and rollback
-- ---------------------------------------------------------------------------
reset role;
do $$ begin
  raise notice '=== ALL SHOPIFY TOKEN REFRESH TESTS PASSED ===';
end $$;
rollback;
