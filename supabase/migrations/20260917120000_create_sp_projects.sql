-- ============================================================================
-- StorePilot Phase 2A — sp_projects
-- ----------------------------------------------------------------------------
-- A "project" is one store-launch effort owned by exactly one authenticated
-- user. It is the tenancy root: every other StorePilot table hangs off it and
-- derives its ownership from it.
--
-- Multi-tenancy model: single-database, row-level tenancy keyed on
-- `user_id = auth.uid()`. There is no org/team concept in Phase 2A; adding one
-- later means introducing an memberships table and widening the policies, not
-- reshaping these tables.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Shared updated_at trigger function.
-- Declared here (first migration that needs it) and reused by later tables.
-- We use a trigger rather than an application-supplied timestamp so that
-- `updated_at` cannot be spoofed or forgotten by a client.
-- ---------------------------------------------------------------------------
create or replace function public.sp_set_updated_at()
returns trigger
language plpgsql
-- SECURITY INVOKER (the default) is correct here: the function only touches the
-- NEW record of the row already being written, so it needs no extra privileges.
-- search_path is pinned to defeat search_path-hijacking attacks.
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.sp_set_updated_at() is
  'Trigger function: stamps updated_at = now() on every UPDATE. Server-side so clients cannot forge it.';

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.sp_projects (
  id uuid primary key default gen_random_uuid(),

  -- Ownership. ON DELETE CASCADE: deleting the auth user erases their projects.
  -- Rationale: StorePilot projects have no meaning without their owner, and
  -- leaving orphaned rows behind would be both a GDPR-deletion problem and an
  -- RLS hazard (rows whose user_id matches no live user are unreachable but
  -- still stored).
  user_id uuid not null references auth.users (id) on delete cascade,

  name text not null default 'Untitled Store',

  -- Wizard lifecycle. Deliberately coarse (4 values), not one status per
  -- wizard step — `current_step` already carries step granularity, and
  -- duplicating it in `status` would create two sources of truth that drift.
  --   draft       : created, nothing meaningful entered yet
  --   in_progress : user has begun supplying real data
  --   ready       : wizard completed, awaiting launch
  --   archived    : hidden from the dashboard, retained for history
  status text not null default 'draft'
    constraint sp_projects_status_check
    check (status in ('draft', 'in_progress', 'ready', 'archived')),

  -- Must match the six wizard step keys in src/lib/wizard/steps.ts exactly.
  -- This is the durable resume pointer the dashboard "Continue" link uses.
  current_step text not null default 'connect'
    constraint sp_projects_current_step_check
    check (current_step in ('connect', 'business', 'catalog', 'blueprint', 'build', 'launch')),

  progress_percent smallint not null default 0
    constraint sp_projects_progress_percent_check
    check (progress_percent >= 0 and progress_percent <= 100),

  -- Denormalised summary columns, mirrored from sp_business_profiles by the
  -- Business-step server action in a single transaction-like write path.
  -- Rationale is documented on sp_business_profiles: the dashboard card must
  -- render industry/currency without joining, and the business profile row is
  -- the sole writer of these columns.
  industry text,
  country_code text,
  currency_code text default 'USD',
  primary_language text default 'en',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sp_projects is
  'One store-launch project. Tenancy root; ownership is user_id = auth.uid(), enforced by RLS.';
comment on column public.sp_projects.current_step is
  'Durable wizard resume pointer. Must stay in sync with the step keys in src/lib/wizard/steps.ts.';
comment on column public.sp_projects.industry is
  'Denormalised mirror of sp_business_profiles.industry. Written ONLY by the Business-step server action.';

-- Dashboard lists a user''s projects newest-first; this index serves that query.
create index if not exists sp_projects_user_id_updated_at_idx
  on public.sp_projects (user_id, updated_at desc);

create trigger sp_projects_set_updated_at
  before update on public.sp_projects
  for each row execute function public.sp_set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- RLS is the ONLY thing standing between tenants. The application never filters
-- by user_id as its sole defence; every policy below re-derives ownership from
-- auth.uid() (the verified JWT subject) and never from a client-supplied value.
alter table public.sp_projects enable row level security;

-- Belt and braces: FORCE makes the policies apply even to the table owner, so a
-- future SECURITY DEFINER function or a migration running as the owner cannot
-- silently bypass tenancy.
alter table public.sp_projects force row level security;

-- SELECT: a user sees only their own projects. This is what makes scenario B
-- (User B cannot read User A's project) and scenario G (forging a projectId in
-- the URL returns nothing) fail closed — a forged id simply matches no visible
-- row, so the app renders "project not found" rather than leaking data.
create policy "sp_projects_select_own"
  on public.sp_projects
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- INSERT: the WITH CHECK is the important half. It rejects any row whose
-- user_id is not the caller, so a client that POSTs someone else's user_id
-- cannot plant a project in another tenant's account.
create policy "sp_projects_insert_own"
  on public.sp_projects
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

-- UPDATE: USING decides which rows are visible to update (scenario C: B sees
-- none of A's rows, so the UPDATE affects 0 rows). WITH CHECK additionally
-- prevents an owner from re-assigning their own project to another user_id,
-- which would otherwise be a way to push data into a foreign tenant.
create policy "sp_projects_update_own"
  on public.sp_projects
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- DELETE: scenario D. B's DELETE matches no visible row and affects 0 rows.
create policy "sp_projects_delete_own"
  on public.sp_projects
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- NOTE: no policy is granted to the `anon` role, at all. With RLS enabled and
-- zero applicable policies, every anonymous statement fails closed (scenario F).
