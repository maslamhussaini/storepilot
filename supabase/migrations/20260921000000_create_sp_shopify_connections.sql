-- ============================================================================
-- StorePilot Phase 2B.3A — sp_shopify_connections
-- ----------------------------------------------------------------------------
-- Non-secret Shopify installation/connection metadata, one active row per
-- project/shop pair. Token material is never stored here; it lives in
-- Supabase Vault and is referenced by `vault_secret_id`.
--
-- Ownership invariant:
--   * `user_id` is stamped server-side from the owning project, never from
--     client input.
--   * RLS verifies BOTH `user_id = auth.uid()` AND project ownership via
--     EXISTS subquery — a forged `user_id` alone or a foreign `project_id`
--     alone cannot read a connection.
--   * A BEFORE INSERT/UPDATE trigger re-derives the owner from `sp_projects`
--     at write time, so even a superuser/service_role write path cannot
--     attach a connection to a project owned by a different user.
--
--     (An earlier draft used a table CHECK constraint with an EXISTS
--     subquery. PostgreSQL rejects that: "cannot use subquery in check
--     constraint" — verified against PostgreSQL 17. The trigger is the
--     schema-legal equivalent and, unlike a CHECK, it fails closed for
--     callers whose RLS view of sp_projects is empty.)
--
-- Uniqueness invariants (partial unique indexes):
--   * A project has at most one ACTIVE connection (status = 'connected').
--   * A shop domain has at most one ACTIVE connection across ALL projects.
--   * Disconnected/uninstalled historical rows may remain; they do not block
--     reconnection because the partial indexes only fire for status='connected'.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Ownership enforcement trigger
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (deliberate): the lookup of sp_projects runs with the
-- privileges and RLS context of the row's writer.
--   * postgres / service_role (RLS-bypassing server context) see every
--     project, so the check reduces to "project exists && owner matches".
--   * A non-bypassing role sees only its own projects through RLS, so a
--     foreign project_id resolves to zero rows and the trigger raises —
--     fail closed, never fail open.
create or replace function public.sp_shopify_connections_enforce_ownership()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_owner_user_id uuid;
begin
  select user_id into v_owner_user_id
  from public.sp_projects
  where id = new.project_id;

  if v_owner_user_id is null then
    raise exception 'sp_shopify_connections: project % not found or not visible to this role', new.project_id;
  end if;

  if new.user_id is distinct from v_owner_user_id then
    raise exception 'sp_shopify_connections: user_id must match the owning project''s user_id';
  end if;

  return new;
end;
$$;

comment on function public.sp_shopify_connections_enforce_ownership() is
  'BEFORE trigger: connection.user_id must equal sp_projects.user_id for connection.project_id. Replaces an EXISTS CHECK constraint, which PostgreSQL rejects.';

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.sp_shopify_connections (
  id uuid primary key default gen_random_uuid(),

  -- Ownership: derived from the project owner, never from client input.
  project_id uuid not null references public.sp_projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  shop_domain text not null,

  -- Explicit status values. 'connected' is the only active state; everything
  -- else is terminal or transitional.
  --   connected        : active, tokens valid (or refreshable)
  --   reauth_required  : tokens invalid/expired, merchant must re-authorize
  --   disconnected     : user-initiated disconnect
  --   uninstalled      : Shopify app uninstall webhook received
  status text not null default 'connected'
    constraint sp_shopify_connections_status_check
    check (status in ('connected', 'reauth_required', 'disconnected', 'uninstalled')),

  granted_scopes text[],

  -- Reference to the Supabase Vault secret containing access/refresh tokens.
  -- Nullable so we can represent connection rows whose tokens are gone
  -- (revoked, refresh failed, or a failure path that left metadata behind).
  -- Invariant: a row with status = 'connected' always has a live Vault
  -- secret — guaranteed by store_connection_tokens running as one
  -- transaction (see docs/PHASE2B3A_PERSISTENCE_FOUNDATION_REPORT.md §9).
  vault_secret_id uuid,

  -- Token expiry metadata only — never the token strings themselves.
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,

  installed_at timestamptz,
  disconnected_at timestamptz,
  last_verified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sp_shopify_connections is
  'One Shopify connection per project/shop. Token material lives in Supabase Vault, referenced by vault_secret_id. Ownership double-checked: own user_id AND owned project_id.';
comment on column public.sp_shopify_connections.user_id is
  'Row owner. Must equal auth.uid(); stamped server-side from project owner, never trusted from client input. Trigger-verified against sp_projects.user_id.';
comment on column public.sp_shopify_connections.project_id is
  'Parent project. RLS additionally verifies via EXISTS that this project belongs to auth.uid().';
comment on column public.sp_shopify_connections.vault_secret_id is
  'Reference to the Supabase Vault secret containing access/refresh tokens. Never the token strings themselves.';
comment on column public.sp_shopify_connections.status is
  'connected | reauth_required | disconnected | uninstalled. Partial unique indexes enforce at most one connected row per project and per shop.';
comment on column public.sp_shopify_connections.granted_scopes is
  'Shopify OAuth scope string split to an array (empty array = zero-scope install). Non-secret: scopes are shown on Shopify''s consent screen.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists sp_shopify_connections_project_id_idx
  on public.sp_shopify_connections(project_id);

create index if not exists sp_shopify_connections_shop_domain_idx
  on public.sp_shopify_connections(shop_domain);

create index if not exists sp_shopify_connections_status_idx
  on public.sp_shopify_connections(status);

create index if not exists sp_shopify_connections_user_id_idx
  on public.sp_shopify_connections(user_id);

-- Partial unique indexes: enforce at most one ACTIVE connection per project
-- and per shop domain. Historical rows (status != 'connected') are excluded
-- so reconnection history is preserved. Partial UNIQUE CONSTRAINTS are not
-- supported with a WHERE clause on the CONSTRAINT form in a portable way here,
-- so plain (partial) UNIQUE INDEXES are used — see report §4.
create unique index if not exists sp_shopify_connections_one_active_per_project
  on public.sp_shopify_connections(project_id)
  where status = 'connected';

create unique index if not exists sp_shopify_connections_one_active_per_shop
  on public.sp_shopify_connections(shop_domain)
  where status = 'connected';

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create trigger sp_shopify_connections_set_updated_at
  before update on public.sp_shopify_connections
  for each row execute function public.sp_set_updated_at();

create trigger sp_shopify_connections_enforce_ownership
  before insert or update on public.sp_shopify_connections
  for each row execute function public.sp_shopify_connections_enforce_ownership();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.sp_shopify_connections enable row level security;
alter table public.sp_shopify_connections force row level security;

-- SELECT: a user sees only connections for projects they own. The EXISTS
-- subquery is a second, independent tenancy check that prevents a connection
-- whose project_id was forged from ever being readable.
create policy "sp_shopify_connections_select_own"
  on public.sp_shopify_connections
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.sp_projects p
      where p.id = sp_shopify_connections.project_id
        and p.user_id = (select auth.uid())
    )
  );

-- INSERT/UPDATE/DELETE: no policy granted to authenticated or anon.
-- All mutation goes through SECURITY DEFINER functions only.
-- (No policies = denied by RLS default.)

-- As with all StorePilot tables: the `anon` role receives no policy, so
-- anonymous access fails closed.
