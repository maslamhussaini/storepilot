-- Local-only fake fixtures for Phase 2B.3B-2B reproduction & integration tests.
-- All credentials are unmistakably fake. Idempotent: removes prior fixtures first.
\set ON_ERROR_STOP on

delete from public.sp_shopify_connection_events
  where project_id = 'ab000000-0000-4000-8000-000000000002';

-- Remove the Vault secret TOGETHER with its connection: a connection row
-- without its secret (or a secret without its row) is an orphan, and the
-- persistence/RLS suite asserts that zero orphans exist.
do $$
declare
  v_secret uuid;
begin
  select vault_secret_id into v_secret
    from public.sp_shopify_connections
   where project_id = 'ab000000-0000-4000-8000-000000000002';
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;
end $$;

delete from public.sp_shopify_connections
  where project_id = 'ab000000-0000-4000-8000-000000000002';
delete from public.sp_projects
  where id = 'ab000000-0000-4000-8000-000000000002';
delete from auth.users where id = 'ab000000-0000-4000-8000-000000000001';

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values ('ab000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'integration-2b@storepilot.test', 'x',
        now(), now(), now());

insert into public.sp_projects (id, user_id, name)
values ('ab000000-0000-4000-8000-000000000002', 'ab000000-0000-4000-8000-000000000001',
        '2B Integration Fixture');

-- OAuth-shaped fake connection: expired access token, valid refresh token.
-- (Run as postgres; the production role path is exercised over REST by the
-- integration tests themselves.)
select public.store_connection_tokens(
  'ab000000-0000-4000-8000-000000000002',
  'integration-2b.myshopify.com',
  '{"access_token":"fake-access-integration-expired",
    "refresh_token":"fake-refresh-integration-valid",
    "expires_in":3600,
    "refresh_token_expires_in":7776000,
    "scope":""}'::jsonb
) is not null as stored;

-- Force the access token into the past: expired -> refresh path required.
update public.sp_shopify_connections
   set access_token_expires_at = now() - interval '5 minutes'
 where project_id = 'ab000000-0000-4000-8000-000000000002';

select id, project_id, status, credential_version, refresh_claim_id,
       access_token_expires_at, refresh_token_expires_at
  from public.sp_shopify_connections
 where project_id = 'ab000000-0000-4000-8000-000000000002';
