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
--     alone cannot create or read a connection.
--
-- Uniqueness invariants (partial unique indexes):
--   * A project has at most one ACTIVE connection (status = 'connected').
--   * A shop domain has at most one ACTIVE connection across ALL projects.
--   * Disconnected/uninstalled historical rows may remain; they do not block
--     reconnection because the partial indexes only fire for status='connected'.
-- ============================================================================

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
  -- Nullable so we can represent connections that have not yet persisted tokens
  -- (e.g. during a failed persistence attempt that left metadata behind).
  vault_secret_id uuid,

  -- Token expiry metadata only — never the token strings themselves.
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,

  installed_at timestamptz,
  disconnected_at timestamptz,
  last_verified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Double-ownership check: the project must belong to the same user who
  -- owns this connection row. Prevents a forged project_id from attaching to
  -- a foreign tenant even if user_id is also forged.
  constraint sp_shopify_connections_project_user_match
    check (
      exists (
        select 1 from public.sp_projects p
        where p.id = sp_shopify_connections.project_id
          and p.user_id = sp_shopify_connections.user_id
      )
    )
);

comment on table public.sp_shopify_connections is
  'One active Shopify connection per project/shop. Token material lives in Supabase Vault, referenced by vault_secret_id. Ownership double-checked: own user_id AND owned project_id.';
comment on column public.sp_shopify_connections.user_id is
  'Row owner. Must equal auth.uid(); stamped server-side from project owner, never trusted from client input.';
comment on column public.sp_shopify_connections.project_id is
  'Parent project. RLS additionally verifies via EXISTS that this project belongs to auth.uid().';
comment on column public.sp_shopify_connections.vault_secret_id is
  'Reference to the Supabase Vault secret containing access/refresh tokens. Never the token strings themselves.';
comment on column public.sp_shopify_connections.status is
  'connected | reauth_required | disconnected | uninstalled. Partial unique indexes enforce at most one connected row per project and per shop.';

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
-- so reconnection history is preserved.
create unique index if not exists sp_shopify_connections_one_active_per_project
  on public.sp_shopify_connections(project_id)
  where status = 'connected';

create unique index if not exists sp_shopify_connections_one_active_per_shop
  on public.sp_shopify_connections(shop_domain)
  where status = 'connected';

-- ---------------------------------------------------------------------------
-- Trigger
-- ---------------------------------------------------------------------------
create trigger sp_shopify_connections_set_updated_at
  before update on public.sp_shopify_connections
  for each row execute function public.sp_set_updated_at();

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
