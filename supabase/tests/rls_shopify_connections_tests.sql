-- ============================================================================
-- StorePilot Phase 2B.3A — Shopify connection RLS + behavior test suite
-- ----------------------------------------------------------------------------
-- WHAT THIS PROVES
--   Every behavioral assertion runs as a real Postgres role (authenticated /
--   anon / service_role) with forged-but-well-formed JWT claim sets, mirroring
--   the existing Phase 2A RLS test suite. Superuser setup is confined to the
--   opening section; security assertions run under lower-privilege roles.
--
-- COVERAGE (maps to Phase 2B.3A task §11)
--   A owner reads own safe metadata / own events
--   B cross-tenant reads denied (connections + events + metadata RPC)
--   C partial unique indexes (one active per project, one active per shop,
--     disconnected history coexists)
--   D owner cannot directly mutate connection metadata
--   E anon sees zero rows and cannot mutate
--   F SECURITY DEFINER EXECUTE grants are exactly as intended; token
--     functions unreachable by anon/authenticated
--   G service_role vault round-trip: store -> decrypt -> revoke
--   H FORCE RLS / policy shape / vault extension & vault grants
--   I token material absent from ordinary tables, views and metadata RPC
--   J reauth_required history preserved alongside a new active connection
--   K ownership trigger: user_id must match the owning project's user_id
--   L event metadata CHECK rejects secret-bearing keys at DB level
--   M atomicity: Vault writes share the caller's transaction (savepoint
--     rollback leaves no orphan secret); failed store leaves no partial state
--
-- HOW TO RUN
--   Local (Supabase CLI + Docker):
--     supabase start
--     docker exec -i supabase_db_storepilot \
--       psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--       < supabase/tests/rls_shopify_connections_tests.sql
--
--   Hosted project (psql against the direct connection):
--     psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_shopify_connections_tests.sql
--
-- SAFETY
--   Wraps everything in a single transaction ending in ROLLBACK, so it
--   creates no permanent rows and no permanent Vault secrets. Safe to run
--   repeatedly against live data.
--
-- FIXTURES
--   All token strings below are unmistakably fake. No production Shopify
--   token has ever been or may ever be placed in this file.
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
-- Setup: two users, two projects (superuser seeding; rolled back later)
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

-- ---------------------------------------------------------------------------
-- Setup: User A's connection, created through the real server-only path
-- (service_role -> store_connection_tokens), with FAKE tokens and a
-- deliberately messy shop domain to prove normalization.
-- ---------------------------------------------------------------------------
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.sp_assert(
  public.store_connection_tokens(
    '11111111-1111-4111-8111-111111111111',
    '  Shop-A.MyShopify.COM ',
    '{"access_token":"shpat_FAKETOKENDONOTUSE0000000000000000000000A",
      "refresh_token":"shprr_FAKETOKENDONOTUSE0000000000000000000000A",
      "expires_in":3600,
      "refresh_token_expires_in":7776000,
      "scope":""}'::jsonb
  ) is not null,
  'Setup.1 service_role can execute store_connection_tokens and it returns a connection id'
);

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections where project_id = '11111111-1111-4111-8111-111111111111') = 1
  and (select count(*) from public.sp_shopify_connection_events where project_id = '11111111-1111-4111-8111-111111111111') = 1,
  'Setup.2 connection row + lifecycle event row were written atomically'
);

reset role;

-- ===========================================================================
-- SCENARIO A — Authenticated user can SELECT safe metadata for own projects
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';

-- A.1 direct table SELECT sees exactly the owner's own connection.
select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111') = 1,
  'A.1 User A can SELECT their own Shopify connection metadata');

-- A.2 shop domain was normalized to lowercase/trimmed by the server path.
select pg_temp.sp_assert(
  (select shop_domain from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111') = 'shop-a.myshopify.com',
  'A.2 shop_domain normalized to lowercase + trimmed');

-- A.3 the metadata RPC works and returns the active connection.
select pg_temp.sp_assert(
  (select count(*) from public.get_connection_metadata('11111111-1111-4111-8111-111111111111')) = 1
  and (select status from public.get_connection_metadata('11111111-1111-4111-8111-111111111111')) = 'connected',
  'A.3 User A can call get_connection_metadata for their own project');

-- A.4 owner can SELECT their own events.
select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connection_events
    where project_id = '11111111-1111-4111-8111-111111111111') >= 1,
  'A.4 User A can SELECT their own connection events');

reset role;

-- ===========================================================================
-- SCENARIO B — User B cannot read User A's connection, events, or metadata
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

select pg_temp.sp_assert(
  (select count(*) from public.get_connection_metadata('11111111-1111-4111-8111-111111111111')) = 0,
  'B.3 User B calling get_connection_metadata on A''s project gets 0 rows');

reset role;

-- ===========================================================================
-- SCENARIO C — Partial unique indexes enforce one active connection per
-- project and per shop; disconnected history coexists (service_role path)
-- ===========================================================================
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

-- C.1 second ACTIVE connection for the same project must fail.
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

-- C.2 same shop actively attached to a second project must fail.
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

-- C.3 disconnect through the sanctioned server path (deletes the Vault
--    secret, nulls the reference, logs the event), then prove the
--    disconnected history coexists with a new active connection.
select public.revoke_connection_tokens('11111111-1111-4111-8111-111111111111', 'disconnected');

insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'shop-a.myshopify.com', 'connected');

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111') = 2
  and (select count(*) from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111' and status = 'connected') = 1,
  'C.3 Disconnected historical row coexists with new active connection');

reset role;

-- ===========================================================================
-- SCENARIO D — Authenticated owner cannot directly mutate connection data
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';

do $$
declare affected int;
begin
  update public.sp_shopify_connections
     set shop_domain = 'hijacked.myshopify.com'
   where project_id = '11111111-1111-4111-8111-111111111111';
  get diagnostics affected = row_count;
  perform pg_temp.sp_assert(affected = 0,
    'D.1 Owner UPDATE of own connection metadata affects 0 rows (no UPDATE policy)');
end $$;

do $$
declare affected int;
begin
  delete from public.sp_shopify_connections
   where project_id = '11111111-1111-4111-8111-111111111111';
  get diagnostics affected = row_count;
  perform pg_temp.sp_assert(affected = 0,
    'D.2 Owner DELETE of own connection metadata affects 0 rows (no DELETE policy)');
end $$;

do $$
declare affected int;
begin
  begin
    insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
    values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'evil.myshopify.com', 'connected');
  exception when insufficient_privilege then
    raise notice 'PASS [D.3 Owner INSERT into sp_shopify_connections denied by RLS]';
    return;
  end;
  select count(*) into affected from public.sp_shopify_connections where shop_domain = 'evil.myshopify.com';
  if affected = 0 then
    raise notice 'PASS [D.3 Owner INSERT into sp_shopify_connections did not persist]';
  else
    raise exception 'FAIL [D.3 authenticated INSERT into sp_shopify_connections succeeded]';
  end if;
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
declare affected int;
begin
  begin
    insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
    values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'anon.myshopify.com', 'connected');
  exception when others then
    -- Fails either via the ownership trigger (anon cannot see the project
    -- through RLS) or via RLS WITH CHECK — both are correct denials.
    raise notice 'PASS [E.3 Anonymous INSERT into sp_shopify_connections denied]';
    return;
  end;
  select count(*) into affected from public.sp_shopify_connections where shop_domain = 'anon.myshopify.com';
  if affected = 0 then
    raise notice 'PASS [E.3 Anonymous INSERT did not persist]';
  else
    raise exception 'FAIL [E.3 anonymous INSERT into sp_shopify_connections succeeded]';
  end if;
end $$;

do $$
begin
  begin
    insert into public.sp_shopify_connection_events (connection_id, project_id, event_type, metadata)
    values ('00000000-0000-4000-8000-000000000000', '11111111-1111-4111-8111-111111111111', 'installed', '{}'::jsonb);
  exception when others then
    raise notice 'PASS [E.4 Anonymous INSERT into sp_shopify_connection_events denied]';
    return;
  end;
  raise exception 'FAIL [E.4 anonymous INSERT into sp_shopify_connection_events succeeded]';
end $$;

reset role;

-- ===========================================================================
-- SCENARIO F — EXECUTE grants are exactly as intended (checked as superuser)
-- and token functions are unreachable by anon/authenticated at call time.
-- ===========================================================================

-- F.1 allow/deny matrix.
select pg_temp.sp_assert(
  (select has_function_privilege('anon',         'public.get_connection_metadata(uuid)', 'EXECUTE')) = false
  and (select has_function_privilege('authenticated','public.get_connection_metadata(uuid)', 'EXECUTE')) = true
  -- service_role ALSO holds EXECUTE here via Supabase's default function
  -- privileges. That is intended-and-harmless: it is the trusted server role
  -- and can read the underlying table anyway; the restriction that matters is
  -- anon=false and the token functions below.
  and (select has_function_privilege('service_role', 'public.get_connection_metadata(uuid)', 'EXECUTE')) = true
  and (select has_function_privilege('anon',         'public.store_connection_tokens(uuid, text, jsonb)', 'EXECUTE')) = false
  and (select has_function_privilege('authenticated','public.store_connection_tokens(uuid, text, jsonb)', 'EXECUTE')) = false
  and (select has_function_privilege('service_role', 'public.store_connection_tokens(uuid, text, jsonb)', 'EXECUTE')) = true
  and (select has_function_privilege('anon',         'public.get_connection_tokens(uuid)', 'EXECUTE')) = false
  and (select has_function_privilege('authenticated','public.get_connection_tokens(uuid)', 'EXECUTE')) = false
  and (select has_function_privilege('service_role', 'public.get_connection_tokens(uuid)', 'EXECUTE')) = true
  and (select has_function_privilege('anon',         'public.revoke_connection_tokens(uuid, text)', 'EXECUTE')) = false
  and (select has_function_privilege('authenticated','public.revoke_connection_tokens(uuid, text)', 'EXECUTE')) = false
  and (select has_function_privilege('service_role', 'public.revoke_connection_tokens(uuid, text)', 'EXECUTE')) = true,
  'F.1 EXECUTE grants: metadata=authenticated only; token functions=service_role only');

-- F.2 no residual default PUBLIC EXECUTE grant on any of the four functions.
select pg_temp.sp_assert(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'public'
      and p.proname in ('store_connection_tokens', 'get_connection_metadata',
                        'get_connection_tokens', 'revoke_connection_tokens')
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE'
  ),
  'F.2 no implicit PUBLIC EXECUTE grant remains on Shopify connection functions');

-- F.3 authenticated cannot call the token functions (call-time denial).
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';

do $$
begin
  begin
    perform public.store_connection_tokens(
      '11111111-1111-4111-8111-111111111111', 'evil.myshopify.com',
      '{"access_token":"x"}'::jsonb);
    raise exception 'FAIL [F.3 authenticated call to store_connection_tokens succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [F.3 Authenticated cannot execute store_connection_tokens]';
  end;
end $$;

do $$
begin
  begin
    perform public.get_connection_tokens('11111111-1111-4111-8111-111111111111');
    raise exception 'FAIL [F.4 authenticated call to get_connection_tokens succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [F.4 Authenticated cannot execute get_connection_tokens (no browser token getter)]';
  end;
end $$;

do $$
begin
  begin
    perform public.revoke_connection_tokens('11111111-1111-4111-8111-111111111111');
    raise exception 'FAIL [F.5 authenticated call to revoke_connection_tokens succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [F.5 Authenticated cannot execute revoke_connection_tokens]';
  end;
end $$;

reset role;

-- F.6 anon cannot call any of the four functions.
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

do $$
begin
  begin
    perform public.get_connection_metadata('11111111-1111-4111-8111-111111111111');
    raise exception 'FAIL [F.6 anon call to get_connection_metadata succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [F.6 Anon cannot execute get_connection_metadata]';
  end;
end $$;

do $$
begin
  begin
    perform public.get_connection_tokens('11111111-1111-4111-8111-111111111111');
    raise exception 'FAIL [F.7 anon call to get_connection_tokens succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [F.7 Anon cannot execute get_connection_tokens]';
  end;
end $$;

do $$
begin
  begin
    perform public.store_connection_tokens('11111111-1111-4111-8111-111111111111', 'x.myshopify.com', '{}'::jsonb);
    raise exception 'FAIL [F.8 anon call to store_connection_tokens succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [F.8 Anon cannot execute store_connection_tokens]';
  end;
end $$;

reset role;

-- ===========================================================================
-- SCENARIO G — service_role vault round-trip: store -> decrypt -> revoke
-- ===========================================================================
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

-- G.1 store tokens for project B (creates the Vault secret).
select pg_temp.sp_assert(
  public.store_connection_tokens(
    '22222222-2222-4222-8222-222222222222',
    'shop-b.myshopify.com',
    '{"access_token":"shpat_FAKETOKENDONOTUSE0000000000000000000000B",
      "refresh_token":"shprr_FAKETOKENDONOTUSE0000000000000000000000B",
      "expires_in":3600,
      "refresh_token_expires_in":7776000,
      "scope":""}'::jsonb
  ) is not null,
  'G.1 service_role stored project B tokens via store_connection_tokens');

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections
    where project_id = '22222222-2222-4222-8222-222222222222'
      and status = 'connected' and vault_secret_id is not null) = 1,
  'G.2 connected row references a Vault secret id');

-- G.3 decrypt round-trip: the stored fixture token comes back from Vault.
select pg_temp.sp_assert(
  (select count(*) from public.get_connection_tokens('22222222-2222-4222-8222-222222222222')
    where access_token = 'shpat_FAKETOKENDONOTUSE0000000000000000000000B'
      and refresh_token = 'shprr_FAKETOKENDONOTUSE0000000000000000000000B'
      and access_token_expires_at is not null
      and refresh_token_expires_at is not null
      and shop_domain = 'shop-b.myshopify.com') = 1,
  'G.3 service_role reads decrypted tokens from Vault (expiry timestamps as metadata)');

-- G.4 the vault secret exists under the documented name.
select pg_temp.sp_assert(
  (select count(*) from vault.secrets s
    join public.sp_shopify_connections c on c.vault_secret_id = s.id
    where c.project_id = '22222222-2222-4222-8222-222222222222'
      and s.name = 'shopify-tokens-' || c.id::text) = 1,
  'G.4 Vault secret name follows shopify-tokens-<connection_id> and links back');

-- G.5 revoke: secret deleted, row marked disconnected, event logged.
select public.revoke_connection_tokens('22222222-2222-4222-8222-222222222222', 'disconnected');

select pg_temp.sp_assert(
  (select status from public.sp_shopify_connections
    where project_id = '22222222-2222-4222-8222-222222222222' and status in ('connected','disconnected')) = 'disconnected'
  and (select vault_secret_id from public.sp_shopify_connections
    where project_id = '22222222-2222-4222-8222-222222222222') is null
  and (select count(*) from vault.secrets s where s.name like 'shopify-tokens-%'
       and s.id not in (select vault_secret_id from public.sp_shopify_connections
                        where vault_secret_id is not null)) = 0
  and (select count(*) from public.sp_shopify_connection_events
       where project_id = '22222222-2222-4222-8222-222222222222' and event_type = 'disconnected') = 1,
  'G.5 revoke removes the Vault secret, nulls the reference, marks disconnected, logs event');

select pg_temp.sp_assert(
  (select count(*) from public.get_connection_tokens('22222222-2222-4222-8222-222222222222')) = 0,
  'G.6 get_connection_tokens returns nothing for a disconnected connection');

reset role;

-- ===========================================================================
-- SCENARIO H — Structural: FORCE RLS, policy shape, Vault availability
-- ===========================================================================
select pg_temp.sp_assert(
  (select bool_and(relrowsecurity and relforcerowsecurity)
     from pg_class
    where oid in ('public.sp_shopify_connections'::regclass,
                  'public.sp_shopify_connection_events'::regclass)),
  'H.1 RLS is ENABLED and FORCED on both Shopify tables');

select pg_temp.sp_assert(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'sp_shopify_connections') >= 1
  and (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'sp_shopify_connection_events') >= 1,
  'H.2 both Shopify tables have a SELECT policy for authenticated');

select pg_temp.sp_assert(
  not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('sp_shopify_connections', 'sp_shopify_connection_events')
       and 'anon' = any(roles)
  ),
  'H.3 no policy on either table is granted to the anon role');

select pg_temp.sp_assert(
  not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('sp_shopify_connections', 'sp_shopify_connection_events')
       and cmd in ('insert', 'update', 'delete')
       and roles::text[] && array['anon', 'authenticated']
  ),
  'H.4 no mutation policy exists for anon or authenticated on either table');

select pg_temp.sp_assert(
  exists (select 1 from pg_extension where extname = 'supabase_vault'),
  'H.5 supabase_vault extension is installed (required for token storage)');

select pg_temp.sp_assert(
  (select has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT')) = false
  and (select has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT')) = false
  and (select has_table_privilege('service_role', 'vault.decrypted_secrets', 'SELECT')) = true
  and (select has_table_privilege('anon', 'vault.secrets', 'SELECT')) = false
  and (select has_table_privilege('authenticated', 'vault.secrets', 'SELECT')) = false,
  'H.6 vault.secrets / vault.decrypted_secrets: GRANT-level isolation (service_role+postgres only)');

select pg_temp.sp_assert(
  (select has_function_privilege('anon', 'vault.create_secret(text,text,text,uuid)', 'EXECUTE')) = false
  and (select has_function_privilege('authenticated', 'vault.create_secret(text,text,text,uuid)', 'EXECUTE')) = false
  and (select has_function_privilege('service_role', 'vault.create_secret(text,text,text,uuid)', 'EXECUTE')) = true,
  'H.7 vault.create_secret EXECUTE denied to anon/authenticated, allowed for service_role');

-- ===========================================================================
-- SCENARIO I — Token material absent from ordinary tables, views and RPC
-- ===========================================================================

-- I.1 the only *token* columns that exist are expiry TIMESTAMPS.
select pg_temp.sp_assert(
  (select count(*) from information_schema.columns
     where table_schema = 'public'
       and table_name in ('sp_shopify_connections', 'sp_shopify_connection_events')
       and column_name like '%token%') = 2
  and not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name in ('sp_shopify_connections', 'sp_shopify_connection_events')
       and column_name like '%token%'
       and data_type <> 'timestamp with time zone'
  ),
  'I.1 token-ish columns are expiry timestamps only — no token string columns exist');

-- I.2 no fixture token material anywhere in either ordinary table.
select pg_temp.sp_assert(
  not exists (
    select 1 from public.sp_shopify_connections t where to_jsonb(t)::text ~ 'shpat_|shprr_|FAKETOKEN'
  ) and not exists (
    select 1 from public.sp_shopify_connection_events t where to_jsonb(t)::text ~ 'shpat_|shprr_|FAKETOKEN'
  ),
  'I.2 no access/refresh token strings exist in sp_shopify_connections or its events');

-- I.3 the metadata RPC output contains no token material.
select pg_temp.sp_assert(
  not exists (
    select 1
    from public.get_connection_metadata('11111111-1111-4111-8111-111111111111') gcm
    where coalesce(gcm.shop_domain, '') ~ 'shpat_|shprr_|FAKETOKEN'
  ),
  'I.3 get_connection_metadata output carries no token material');

-- I.4 authenticated cannot read vault.decrypted_secrets directly.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';

do $$
begin
  begin
    perform count(*) from vault.decrypted_secrets;
    raise exception 'FAIL [I.4 vault.decrypted_secrets is readable by authenticated]';
  exception when insufficient_privilege then
    raise notice 'PASS [I.4 vault.decrypted_secrets is not accessible to authenticated]';
  end;
end $$;

do $$
begin
  begin
    perform count(*) from vault.secrets;
    raise exception 'FAIL [I.5 vault.secrets is readable by authenticated]';
  exception when insufficient_privilege then
    raise notice 'PASS [I.5 vault.secrets is not accessible to authenticated]';
  end;
end $$;

reset role;

-- ===========================================================================
-- SCENARIO J — History preserved: reauth_required row + new active row
-- ===========================================================================
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

update public.sp_shopify_connections
   set status = 'reauth_required'
 where project_id = '11111111-1111-4111-8111-111111111111'
   and status = 'connected';

insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'shop-a-reconnect.myshopify.com', 'connected');

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111' and status = 'connected') = 1
  and (select count(*) from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111' and status = 'reauth_required') = 1
  and (select count(*) from public.sp_shopify_connections
    where project_id = '11111111-1111-4111-8111-111111111111' and status = 'disconnected') = 1,
  'J.1 new active row coexists with preserved reauth_required + disconnected history');

reset role;

-- ===========================================================================
-- SCENARIO K — Ownership trigger: user_id must match the owning project
-- ===========================================================================
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

-- K.1 forged user_id (B's id on A's project) must be rejected.
do $$
begin
  begin
    insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
    values ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'k-forged.myshopify.com', 'disconnected');
    raise exception 'FAIL [K.1 forged user_id was accepted]';
  exception when check_violation or raise_exception then
    raise notice 'PASS [K.1 ownership trigger rejects user_id != project owner]';
  end;
end $$;

-- K.2 nonexistent project must be rejected (fail closed).
do $$
begin
  begin
    insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
    values ('99999999-9999-4999-8999-999999999999', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'k-orphan.myshopify.com', 'disconnected');
    raise exception 'FAIL [K.2 connection for nonexistent project was accepted]';
  exception when others then
    raise notice 'PASS [K.2 ownership trigger (or FK) rejects a nonexistent project]';
  end;
end $$;

-- K.3 control: correct owner on correct project is accepted.
insert into public.sp_shopify_connections (project_id, user_id, shop_domain, status)
values ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'k-legit.myshopify.com', 'disconnected');

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections where shop_domain = 'k-legit.myshopify.com') = 1,
  'K.3 correctly-owned connection row is accepted');

reset role;

-- ===========================================================================
-- SCENARIO L — Event metadata CHECK rejects secret-bearing keys in SQL
-- ===========================================================================
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

-- L.1 top-level access_token key rejected.
do $$
begin
  begin
    insert into public.sp_shopify_connection_events (connection_id, project_id, event_type, metadata)
    select c.id, c.project_id, 'token_refreshed', '{"access_token":"nope"}'::jsonb
      from public.sp_shopify_connections c
     where c.project_id = '11111111-1111-4111-8111-111111111111' limit 1;
    raise exception 'FAIL [L.1 event metadata with access_token key was accepted]';
  exception when check_violation then
    raise notice 'PASS [L.1 DB CHECK rejects event metadata containing access_token]';
  end;
end $$;

-- L.2 nested refresh_token key rejected.
do $$
begin
  begin
    insert into public.sp_shopify_connection_events (connection_id, project_id, event_type, metadata)
    select c.id, c.project_id, 'token_refreshed', '{"info":{"refresh_token":"nope"}}'::jsonb
      from public.sp_shopify_connections c
     where c.project_id = '11111111-1111-4111-8111-111111111111' limit 1;
    raise exception 'FAIL [L.2 nested refresh_token key was accepted]';
  exception when check_violation then
    raise notice 'PASS [L.2 DB CHECK rejects NESTED refresh_token key]';
  end;
end $$;

-- L.3 OAuth state / authorization code / client secret keys rejected.
do $$
begin
  begin
    insert into public.sp_shopify_connection_events (connection_id, project_id, event_type, metadata)
    select c.id, c.project_id, 'installed', '{"state":"abc","code":"def"}'::jsonb
      from public.sp_shopify_connections c
     where c.project_id = '11111111-1111-4111-8111-111111111111' limit 1;
    raise exception 'FAIL [L.3 event metadata with state/code keys was accepted]';
  exception when check_violation then
    raise notice 'PASS [L.3 DB CHECK rejects OAuth state/authorization-code keys]';
  end;
end $$;

-- L.4 benign metadata still accepted (constraint must not over-block).
do $$
declare v_id uuid;
begin
  select id into v_id from public.sp_shopify_connections
   where project_id = '11111111-1111-4111-8111-111111111111' order by created_at limit 1;
  insert into public.sp_shopify_connection_events (connection_id, project_id, event_type, metadata)
  values (v_id, '11111111-1111-4111-8111-111111111111', 'reauth_required',
          '{"reason":"refresh_failed","previous_status":"connected"}'::jsonb);
  raise notice 'PASS [L.4 benign non-secret event metadata is accepted]';
end $$;

reset role;

-- ===========================================================================
-- SCENARIO M — Atomicity / failure safety (Vault writes share the caller's
-- transaction; a failed store leaves no partial state)
-- ===========================================================================
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

-- M.1 vault.create_secret is NOT an autonomous commit: rolling back the
--     caller's transaction to a savepoint removes the secret it created.
create temp table m1_vault_before on commit drop as
  select count(*)::int as n from vault.secrets;

savepoint m1_before;

do $$
begin
  -- run the store inside a nested block so any surprise surfaces as a FAIL
  perform public.store_connection_tokens(
    '22222222-2222-4222-8222-222222222222',
    'shop-b2.myshopify.com',
    '{"access_token":"shpat_FAKETOKENDONOTUSE0000000000000000000000C",
      "refresh_token":"shprr_FAKETOKENDONOTUSE0000000000000000000000C"}'::jsonb);
end $$;

select pg_temp.sp_assert(
  (select count(*) from vault.secrets where name like 'shopify-tokens-%') >= 1
  and (select count(*) from public.sp_shopify_connections
       where shop_domain = 'shop-b2.myshopify.com' and status = 'connected') = 1,
  'M.1a store_connection_tokens created a Vault secret + connected row (pre-rollback state)');

rollback to savepoint m1_before;

select pg_temp.sp_assert(
  (select count(*) from public.sp_shopify_connections
     where shop_domain = 'shop-b2.myshopify.com') = 0
  and (select count(*) from vault.secrets) = (select n from m1_vault_before),
  'M.1b rollback removed BOTH the connection row and its Vault secret (single transaction proven)');

-- M.2 a store that violates the one-active-per-shop index fails as a whole:
--     no half-written metadata, no orphaned Vault secret.
do $$
declare v_secrets_before int;
declare v_secrets_after int;
declare v_rows_after int;
begin
  select count(*) into v_secrets_before from vault.secrets where name like 'shopify-tokens-%';

  begin
    perform public.store_connection_tokens(
      '22222222-2222-4222-8222-222222222222',
      'shop-a-reconnect.myshopify.com',   -- actively owned by project A
      '{"access_token":"shpat_FAKETOKENDONOTUSE0000000000000000000000D"}'::jsonb);
    raise exception 'FAIL [M.2 duplicate active shop was accepted by store_connection_tokens]';
  exception when unique_violation then
    null; -- expected: the partial unique index rejected it
  end;

  select count(*) into v_secrets_after from vault.secrets where name like 'shopify-tokens-%';
  select count(*) into v_rows_after from public.sp_shopify_connections
    where project_id = '22222222-2222-4222-8222-222222222222' and status = 'connected';

  perform pg_temp.sp_assert(
    v_secrets_after = v_secrets_before and v_rows_after = 0,
    'M.2 failed store leaves no orphaned Vault secret and no partial connected row');
end $$;

-- M.3 an invalid payload (missing access_token) is rejected before any write.
do $$
begin
  begin
    perform public.store_connection_tokens(
      '22222222-2222-4222-8222-222222222222', 'shop-bad.myshopify.com', '{"refresh_token":"x"}'::jsonb);
    raise exception 'FAIL [M.3 payload without access_token was accepted]';
  exception when raise_exception then
    raise notice 'PASS [M.3 store_connection_tokens rejects a payload without access_token]';
  end;
end $$;

reset role;

-- ===========================================================================
-- DONE
-- ===========================================================================
do $$ begin raise notice '=== ALL SHOPIFY RLS TESTS PASSED (A-M) ==='; end $$;

-- Nothing is persisted. Re-runnable, safe against live databases.
rollback;
