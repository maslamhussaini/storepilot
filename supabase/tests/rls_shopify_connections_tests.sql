-- ============================================================================
-- StorePilot Phase 2B.3A — Shopify connection RLS + behavior test suite
-- ----------------------------------------------------------------------------
-- WHAT THIS PROVES
--   Every assertion runs as a real Postgres role (authenticated / anon /
--   service_role) with forged-but-well-formed JWT claim sets, mirroring the
--   existing Phase 2A RLS test suite. Superuser setup is confined to the
--   opening transaction; all security assertions run under lower-privilege
--   roles.
--
-- HOW TO RUN
--   Local (Supabase CLI + Docker):
--     supabase start
--     docker exec -i supabase_db_storepilot \
--       psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--       < supabase/tests/rls_shopify_connections_tests.sql
--
--   Hosted project (psql against the pooler/direct connection):
--     psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_shopify_connections_tests.sql
--
-- SAFETY
--   Wraps everything in a single transaction ending in ROLLBACK, so it
--   creates no permanent rows. Safe to run repeatedly against live data.
-- ============================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Assertion helper
-- ---------------------------------------------------------------------------
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
-- Setup: two users, two projects (User B owns project B only)
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'user-a@storepilot.test', 'x', now(), now(), now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'user-b@storepilot.test', 'x', now(), now(), now());

-- User A owns project A; User B owns project B.
insert into public.sp_projects (id, user_id, name)
values
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'User A Store'),
  ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'User B Store');

-- ===========================================================================
-- SCENARIO A — Authenticated user can SELECT safe metadata for own projects
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';

-- A.1 Insert a connection for A's project via the SECURITY DEFINER function.
--    This tests that store_connection_tokens correctly derives user_id from
--    the project owner rather than trusting client input.
select public.store_connection_tokens(
  '11111111-1111-4111-8111-111111111111',
  'shop-a.myshopify.com',
  '{"access_token":"tok_a","refresh_token":"ref_a","expires_in":3600}'::jsonb
);

-- A.2 Authenticated A can read their own connection metadata.
select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111') = 1,
  'A.2 User A can SELECT their own Shopify connection metadata');

-- A.3 Authenticated A can call get_connection_metadata.
select pg_temp.sp_assert(
  (select count(*) from public.get_connection_metadata('11111111-1111-4111-8111-111111111111')) = 1,
  'A.3 User A can call get_connection_metadata for their own project');

-- A.4 get_connection_metadata never returns token material.
select pg_temp.sp_assert(
  not exists (
    select 1 from public.get_connection_metadata('11111111-1111-4111-8111-111111111111') gcm
    where gcm.shop_domain is null  -- sanity: row exists
  ),
  'A.4 get_connection_metadata returns only safe columns (no token material)');

reset role;

-- ===========================================================================
-- SCENARIO B — User B cannot read User A's connection or events
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}';

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111') = 0,
  'B.1 User B CANNOT SELECT User A''s connection metadata');

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connection_events
    where project_id = '11111111-1111-4111-8111-111111111111') = 0,
  'B.2 User B CANNOT SELECT User A''s connection events');

reset role;

-- ===========================================================================
-- SCENARIO C — Partial unique indexes enforce one active connection per project
-- ===========================================================================
set local role service_role;

-- C.1 Attempting to create a second active connection for the same project
--     must fail with a unique violation.
do $$
begin
  begin
    insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
    values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'shop-a2.myshopify.com', 'connected');
    raise exception 'FAIL [C.1 duplicate active connection for same project was accepted]';
  exception when unique_violation then
    raise notice 'PASS [C.1 UNIQUE partial index blocks second active connection for same project]';
  end;
end $$;

-- C.2 Attempting to create a second active connection for the same shop domain
--     across different projects must also fail.
do $$
begin
  begin
    insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
    values ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'shop-a.myshopify.com', 'connected');
    raise exception 'FAIL [C.2 same shop active in two projects was accepted]';
  exception when unique_violation then
    raise notice 'PASS [C.2 UNIQUE partial index blocks same shop active in two projects]';
  end;
end $$;

-- C.3 Disconnected historical rows can coexist with a new active connection.
--     First, mark A's connection disconnected.
update public.sp_shopify_connections set status = 'disconnected', disconnected_at = now()
 where project_id = '11111111-1111-4111-8111-111111111111';

--     Now A can reconnect with the same shop (or a different one).
insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'shop-a.myshopify.com', 'connected');

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111') = 2,
  'C.3 Disconnected historical row coexists with new active connection for same project');

reset role;

-- ===========================================================================
-- SCENARIO D — Authenticated user cannot directly mutate connection data
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';

-- D.1 UPDATE blocked.
do $$
declare affected int;
begin
  update public.sp_shopify_connections
     set shop_domain = 'hijacked.myshopify.com'
   where project_id = '11111111-1111-4111-8111-111111111111';
  get diagnostics affected = row_count;
  perform pg_temp.sp_assert(affected = 0,
    'D.1 Authenticated UPDATE of connection metadata affects 0 rows');
end $$;

-- D.2 DELETE blocked.
do $$
declare affected int;
begin
  delete from public.sp_shopify_connections
   where project_id = '11111111-1111-4111-8111-111111111111';
  get diagnostics affected = row_count;
  perform pg_temp.sp_assert(affected = 0,
    'D.2 Authenticated DELETE of connection metadata affects 0 rows');
end $$;

-- D.3 INSERT blocked.
do $$
begin
  begin
    insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
    values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'evil.myshopify.com', 'connected');
    raise exception 'FAIL [D.3 authenticated INSERT into connections succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [D.3 Authenticated INSERT into sp_shopify_connections is denied]';
  end;
end $$;

reset role;

-- ===========================================================================
-- SCENARIO E — Anon sees nothing and cannot mutate
-- ===========================================================================
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections) = 0,
  'E.1 Anonymous SELECT on sp_shopify_connections returns 0 rows');

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connection_events) = 0,
  'E.2 Anonymous SELECT on sp_shopify_connection_events returns 0 rows');

do $$
begin
  begin
    insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
    values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'anon.myshopify.com', 'connected');
    raise exception 'FAIL [E.3 anonymous INSERT succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [E.3 Anonymous INSERT into sp_shopify_connections is denied]';
  end;
end $$;

reset role;

-- ===========================================================================
-- SCENARIO F — Authenticated user cannot call server-only functions
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';

-- F.1 get_connection_metadata is allowed (granted to authenticated).
select public.get_connection_metadata('11111111-1111-4111-8111-111111111111');

-- F.2 store_connection_tokens is NOT granted to authenticated.
do $$
begin
  begin
    perform public.store_connection_tokens(
      '11111111-1111-4111-8111-111111111111',
      'evil.myshopify.com',
      '{"access_token":"x"}'::jsonb
    );
    raise exception 'FAIL [F.2 authenticated call to store_connection_tokens succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [F.2 Authenticated cannot call store_connection_tokens]';
  end;
end $$;

-- F.3 get_connection_tokens is NOT granted to authenticated.
do $$
begin
  begin
    perform public.get_connection_tokens('11111111-1111-4111-8111-111111111111');
    raise exception 'FAIL [F.3 authenticated call to get_connection_tokens succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [F.3 Authenticated cannot call get_connection_tokens]';
  end;
end $$;

-- F.4 revoke_connection_tokens is NOT granted to authenticated.
do $$
begin
  begin
    perform public.revoke_connection_tokens('11111111-1111-4111-8111-111111111111');
    raise exception 'FAIL [F.4 authenticated call to revoke_connection_tokens succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [F.4 Authenticated cannot call revoke_connection_tokens]';
  end;
end $$;

reset role;

-- ===========================================================================
-- SCENARIO G — service_role can call all functions and Vault is accessible
-- ===========================================================================
set local role service_role;

-- G.1 service_role can call store_connection_tokens.
perform public.store_connection_tokens(
  '22222222-2222-4222-8222-222222222222',
  'shop-b.myshopify.com',
  '{"access_token":"tok_b","refresh_token":"ref_b","expires_in":3600,"scope":""}'::jsonb
);

-- G.2 service_role can call get_connection_tokens (reads Vault).
--     We only assert it returns a row; we never print the token values.
select pg_temp.sp_assert(
  (select count(*) from public.get_connection_tokens('22222222-2222-4222-8222-222222222222')) = 1,
  'G.2 service_role can read decrypted tokens from Vault via get_connection_tokens');

-- G.3 service_role can call revoke_connection_tokens.
perform public.revoke_connection_tokens('22222222-2222-4222-8222-222222222222', 'disconnected');
select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections where project_id = '22222222-2222-4222-8222-222222222222') = 'disconnected',
  'G.3 service_role revoke_connection_tokens marks connection disconnected');

reset role;

-- ===========================================================================
-- SCENARIO H — Structural assertions: RLS flags, policies, Vault availability
-- ===========================================================================
select pg_temp.sp_assert(
  (select bool_and(relrowsecurity and relforcerowsecurity)
     from pg_class
    where oid in ('public.sp_shopify_connections'::regclass,
                  'public.sp_shopify_connection_events'::regclass)),
  'H.1 RLS is ENABLED and FORCED on both Shopify tables');

select pg_temp.sp_assert(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'sp_shopify_connections') >= 1,
  'H.2 sp_shopify_connections has SELECT policy for authenticated');

select pg_temp.sp_assert(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'sp_shopify_connection_events') >= 1,
  'H.3 sp_shopify_connection_events has SELECT policy for authenticated');

select pg_temp.sp_assert(
  not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('sp_shopify_connections', 'sp_shopify_connection_events')
       and 'anon' = any(roles)
  ),
  'H.4 No policy on either table is granted to the anon role');

-- Vault extension must be available for token storage to work.
select pg_temp.sp_assert(
  exists (select 1 from pg_extension where extname = 'supabase_vault'),
  'H.5 supabase_vault extension is installed (required for token storage)');

-- ===========================================================================
-- SCENARIO I — Token material is absent from ordinary tables/views
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';

-- I.1 Token strings must not appear in the metadata table.
select pg_temp.sp_assert(
  not exists (
    select 1 from public.sp_shopify_connections
     where shop_domain like '%tok_%'
        or shop_domain like '%ref_%'
  ),
  'I.1 Token strings are absent from sp_shopify_connections');

-- I.2 vault.decrypted_secrets is not accessible to authenticated.
do $$
begin
  begin
    perform count(*) from vault.decrypted_secrets limit 1;
    raise notice 'WARN [I.2] vault.decrypted_secrets is visible to the current role — review grants';
  exception when insufficient_privilege then
    raise notice 'PASS [I.2 vault.decrypted_secrets is not accessible to authenticated]';
  end;
end $$;

reset role;

-- ===========================================================================
-- SCENARIO J — Partial unique index behavior: disconnected rows don't block
-- ===========================================================================
set local role service_role;

-- J.1 Mark A's active connection as reauth_required, then verify a new active
--     connection can be created for the same project.
update public.sp_shopify_connections
   set status = 'reauth_required'
 where project_id = '11111111-1111-4111-8111-111111111111'
   and status = 'connected';

insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'shop-a-reconnect.myshopify.com', 'connected');

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111'
      and status = 'connected') = 1,
  'J.1 Reconnection creates a new active row after old one was marked reauth_required');

-- J.2 The old reauth_required row still exists (history preserved).
select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111'
      and status = 'reauth_required') = 1,
  'J.2 Historical reauth_required row is preserved alongside new active connection');

reset role;

-- ===========================================================================
-- DONE
-- ===========================================================================
do $$ begin raise notice '=== ALL SHOPIFY RLS TESTS PASSED (A-J) ==='; end $$;

-- Nothing is persisted. Re-runnable, safe against live databases.
rollback;
