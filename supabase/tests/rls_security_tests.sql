-- ============================================================================
-- StorePilot Phase 2A — RLS security test suite (scenarios A–G)
-- ----------------------------------------------------------------------------
-- WHAT THIS PROVES
--   Every assertion below runs as a *real* Postgres role (`authenticated` /
--   `anon`) with a forged-but-well-formed JWT claim set, which is exactly the
--   context PostgREST gives a Supabase client. Nothing here runs as a
--   superuser once setup is done, because superusers bypass RLS entirely and
--   would make the whole suite vacuously pass.
--
-- HOW TO RUN
--   Local (Supabase CLI + Docker):
--     supabase start
--     docker exec -i supabase_db_storepilot \
--       psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--       < supabase/tests/rls_security_tests.sql
--
--   Hosted project (psql against the pooler/direct connection):
--     psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_security_tests.sql
--
-- SAFETY
--   The entire suite runs inside a single transaction that ends in ROLLBACK,
--   so it creates no permanent rows — not even the two test users in
--   auth.users. It is safe to run repeatedly, including against a database
--   that already has real data.
--
-- RESULT CONVENTION
--   Each assertion emits `PASS [x] ...` as a NOTICE. Any failure raises an
--   exception, which with ON_ERROR_STOP=1 aborts the run with a non-zero exit
--   code. A run that prints every PASS line and reaches "ALL RLS TESTS PASSED"
--   is a green suite.
-- ============================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Assertion helper. Created inside the transaction, rolled back with it.
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
-- Setup (runs as the connecting superuser; RLS is bypassed here on purpose so
-- we can plant User A's fixture data without going through the policies).
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'user-a@storepilot.test', 'x', now(), now(), now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'user-b@storepilot.test', 'x', now(), now(), now());

-- ===========================================================================
-- SCENARIO A — User A can create / read / update their own project.
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';

-- A.1 create
insert into public.sp_projects (id, user_id, name)
values ('11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'User A Store');
select pg_temp.sp_assert(
  (select count(*) from public.sp_projects
   where id = '11111111-1111-4111-8111-111111111111') = 1,
  'A.1 User A can CREATE and then SELECT their own project');

-- A.2 update
update public.sp_projects
   set current_step = 'business', progress_percent = 33, status = 'in_progress'
 where id = '11111111-1111-4111-8111-111111111111';
select pg_temp.sp_assert(
  (select current_step from public.sp_projects
   where id = '11111111-1111-4111-8111-111111111111') = 'business',
  'A.2 User A can UPDATE their own project (wizard progress persists)');

-- A.3 own business profile, correctly owned -> allowed
insert into public.sp_business_profiles (project_id, user_id, business_name, industry)
values ('11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Royal Oud', 'beauty');
select pg_temp.sp_assert(
  (select count(*) from public.sp_business_profiles
   where project_id = '11111111-1111-4111-8111-111111111111') = 1,
  'A.3 User A can CREATE a business profile on their own project');

-- A.4 the one-profile-per-project invariant actually holds
do $$
begin
  begin
    insert into public.sp_business_profiles (project_id, user_id, business_name)
    values ('11111111-1111-4111-8111-111111111111',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Duplicate');
    raise exception 'FAIL [A.4 duplicate business profile was accepted]';
  exception when unique_violation then
    raise notice 'PASS [A.4 UNIQUE(project_id) blocks a second business profile]';
  end;
end $$;

reset role;

-- ===========================================================================
-- SCENARIO B — User B cannot READ User A's project.
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}';

select pg_temp.sp_assert(
  (select count(*) from public.sp_projects
   where id = '11111111-1111-4111-8111-111111111111') = 0,
  'B.1 User B CANNOT SELECT User A''s project (0 rows, not an error - fails closed)');

select pg_temp.sp_assert(
  (select count(*) from public.sp_projects) = 0,
  'B.2 An unfiltered SELECT by User B returns none of User A''s rows');

select pg_temp.sp_assert(
  (select count(*) from public.sp_business_profiles
   where project_id = '11111111-1111-4111-8111-111111111111') = 0,
  'B.3 User B CANNOT SELECT User A''s business profile');

-- ===========================================================================
-- SCENARIO C — User B cannot UPDATE User A's project.
-- ===========================================================================
do $$
declare affected int;
begin
  update public.sp_projects
     set name = 'HIJACKED BY B', status = 'archived'
   where id = '11111111-1111-4111-8111-111111111111';
  get diagnostics affected = row_count;
  perform pg_temp.sp_assert(affected = 0,
    'C.1 User B''s UPDATE of User A''s project affects 0 rows');
end $$;

-- ===========================================================================
-- SCENARIO D — User B cannot DELETE User A's project.
-- ===========================================================================
do $$
declare affected int;
begin
  delete from public.sp_projects
   where id = '11111111-1111-4111-8111-111111111111';
  get diagnostics affected = row_count;
  perform pg_temp.sp_assert(affected = 0,
    'D.1 User B''s DELETE of User A''s project affects 0 rows');
end $$;

-- ===========================================================================
-- SCENARIO E — User B cannot create/update a business profile on A's project.
-- Three distinct attack shapes are tested; all must fail.
-- ===========================================================================

-- E.1 B stamps the row with their OWN user_id but points it at A's project.
--     Blocked by the EXISTS(project belongs to auth.uid()) half of WITH CHECK.
do $$
begin
  begin
    insert into public.sp_business_profiles (project_id, user_id, business_name)
    values ('11111111-1111-4111-8111-111111111111',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'B hijack attempt');
    raise exception 'FAIL [E.1 B attached a business profile to A''s project]';
  exception when insufficient_privilege then
    raise notice 'PASS [E.1 B CANNOT attach a profile to A''s project (RLS WITH CHECK / EXISTS)]';
  end;
end $$;

-- E.2 B forges A's user_id. Blocked by the user_id = auth.uid() half.
do $$
begin
  begin
    insert into public.sp_business_profiles (project_id, user_id, business_name)
    values ('11111111-1111-4111-8111-111111111111',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'B forging A''s user_id');
    raise exception 'FAIL [E.2 B inserted a row stamped with A''s user_id]';
  exception when insufficient_privilege then
    raise notice 'PASS [E.2 B CANNOT forge A''s user_id on insert (RLS WITH CHECK)]';
  end;
end $$;

-- E.3 B tries to UPDATE A's existing profile.
do $$
declare affected int;
begin
  update public.sp_business_profiles
     set business_name = 'HIJACKED BY B'
   where project_id = '11111111-1111-4111-8111-111111111111';
  get diagnostics affected = row_count;
  perform pg_temp.sp_assert(affected = 0,
    'E.3 User B''s UPDATE of User A''s business profile affects 0 rows');
end $$;

-- E.4 B may still operate legitimately in their OWN tenant. A suite that
--     blocked everything would also "pass" A-E, so prove the policies are not
--     simply denying all writes.
insert into public.sp_projects (id, user_id, name)
values ('22222222-2222-4222-8222-222222222222',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'User B Store');
insert into public.sp_business_profiles (project_id, user_id, business_name)
values ('22222222-2222-4222-8222-222222222222',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'B Legit Co');
select pg_temp.sp_assert(
  (select count(*) from public.sp_projects) = 1
  and (select count(*) from public.sp_business_profiles) = 1,
  'E.4 Control: User B CAN create their own project + profile, and sees exactly 1 of each');

-- E.5 B cannot re-point their own profile at A's project (WITH CHECK on UPDATE).
do $$
begin
  begin
    update public.sp_business_profiles
       set project_id = '11111111-1111-4111-8111-111111111111'
     where project_id = '22222222-2222-4222-8222-222222222222';
    raise exception 'FAIL [E.5 B moved their profile onto A''s project]';
  exception when insufficient_privilege then
    raise notice 'PASS [E.5 B CANNOT re-point their own profile at A''s project]';
  end;
end $$;

-- E.6 B cannot give their own project away to A (WITH CHECK on UPDATE).
do $$
begin
  begin
    update public.sp_projects
       set user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     where id = '22222222-2222-4222-8222-222222222222';
    raise exception 'FAIL [E.6 B reassigned their project to A]';
  exception when insufficient_privilege then
    raise notice 'PASS [E.6 B CANNOT reassign project ownership to another user]';
  end;
end $$;

reset role;

-- ===========================================================================
-- SCENARIO F — Anonymous users cannot access protected project data.
-- The `anon` role has NO policy on either table, so RLS denies everything.
-- ===========================================================================
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select pg_temp.sp_assert(
  (select count(*) from public.sp_projects) = 0,
  'F.1 Anonymous SELECT on sp_projects returns 0 rows (no policy for anon)');

select pg_temp.sp_assert(
  (select count(*) from public.sp_business_profiles) = 0,
  'F.2 Anonymous SELECT on sp_business_profiles returns 0 rows');

do $$
begin
  begin
    insert into public.sp_projects (user_id, name)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'anon insert');
    raise exception 'FAIL [F.3 anonymous INSERT succeeded]';
  exception when insufficient_privilege then
    raise notice 'PASS [F.3 Anonymous INSERT into sp_projects is denied]';
  end;
end $$;

reset role;

-- ===========================================================================
-- SCENARIO G — Manipulating projectId in the URL exposes nothing.
-- This is the database half of the guarantee. The app always loads a project
-- with `.eq('id', projectId)` under the caller's own session, so a forged id
-- degrades to "0 rows" -> the UI renders "project not found", never A's data.
-- Tested here as B probing A's *real* id and a random non-existent id.
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}';

select pg_temp.sp_assert(
  (select count(*) from public.sp_projects p
    left join public.sp_business_profiles bp on bp.project_id = p.id
   where p.id = '11111111-1111-4111-8111-111111111111') = 0,
  'G.1 B fetching A''s real project id (the URL-tampering path) yields 0 rows');

select pg_temp.sp_assert(
  (select count(*) from public.sp_projects
   where id = '99999999-9999-4999-8999-999999999999') = 0,
  'G.2 B fetching a random non-existent project id yields 0 rows (indistinguishable from G.1)');

reset role;

-- ===========================================================================
-- Structural assertions: RLS is actually ON, not merely policied.
-- A table with policies but RLS disabled is wide open, so assert the flags.
-- ===========================================================================
select pg_temp.sp_assert(
  (select bool_and(relrowsecurity and relforcerowsecurity)
     from pg_class
    where oid in ('public.sp_projects'::regclass,
                  'public.sp_business_profiles'::regclass)),
  'H.1 RLS is ENABLED and FORCED on both sp_projects and sp_business_profiles');

select pg_temp.sp_assert(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'sp_projects') = 4,
  'H.2 sp_projects has exactly 4 policies (select/insert/update/delete)');

select pg_temp.sp_assert(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'sp_business_profiles') = 4,
  'H.3 sp_business_profiles has exactly 4 policies');

select pg_temp.sp_assert(
  not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('sp_projects', 'sp_business_profiles')
       and 'anon' = any(roles)
  ),
  'H.4 No policy on either table is granted to the anon role');

select pg_temp.sp_assert(
  not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('sp_projects', 'sp_business_profiles')
       and coalesce(qual, '') || coalesce(with_check, '') !~ 'auth\.uid\(\)'
  ),
  'H.5 Every policy derives ownership from auth.uid() (no broad authenticated-only policy)');

do $$ begin raise notice '=== ALL RLS TESTS PASSED (A-H) ==='; end $$;

-- Nothing is persisted. Re-runnable, safe against live databases.
rollback;
