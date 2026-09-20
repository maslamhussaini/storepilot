-- ============================================================================
-- StorePilot Phase 2A — sp_business_profiles
-- ----------------------------------------------------------------------------
-- The durable result of wizard step 2 ("Business"). Exactly one row per
-- project, enforced by a UNIQUE constraint on project_id so the server action
-- can use a plain ON CONFLICT upsert.
--
-- This table stores BOTH project_id and user_id. That is deliberate
-- denormalisation for security, not laziness:
--   * user_id lets the RLS policy check row ownership directly, without a join,
--     on every statement.
--   * project_id is additionally validated against sp_projects ownership via an
--     EXISTS subquery, so a forged project_id cannot attach a profile to
--     someone else's project even if the attacker sets user_id to themselves.
-- Both checks must pass. Either one alone is insufficient:
--   - user_id alone would let B attach a profile (owned by B) to A's project.
--   - project_id alone would let B write a row stamped with A's user_id.
-- ============================================================================

create table if not exists public.sp_business_profiles (
  id uuid primary key default gen_random_uuid(),

  -- ON DELETE CASCADE: the profile is a detail record of the project and has no
  -- standalone meaning. Deleting the project must not leave a dangling profile.
  project_id uuid not null references public.sp_projects (id) on delete cascade,

  -- ON DELETE CASCADE: redundant in practice (deleting the auth user already
  -- cascades through sp_projects) but declared explicitly so the invariant
  -- "no row outlives its owner" holds even if the project FK is ever relaxed.
  user_id uuid not null references auth.users (id) on delete cascade,

  -- One business profile per project. Also the conflict target for the
  -- Business-step upsert.
  constraint sp_business_profiles_project_id_key unique (project_id),

  business_name text not null default '',
  description text not null default '',

  industry text,
  country_code text,
  currency_code text not null default 'USD',
  primary_language text not null default 'en',
  secondary_language text,          -- nullable: most merchants are monolingual
  brand_style text,
  logo_url text,                    -- nullable: logo upload is a later phase

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sp_business_profiles is
  'Durable output of the Business wizard step. Exactly one row per project. Ownership double-checked: own user_id AND owned project_id.';
comment on column public.sp_business_profiles.user_id is
  'Row owner. Must equal auth.uid(); never trusted from the client — the server action stamps it from the session.';
comment on column public.sp_business_profiles.project_id is
  'Parent project. RLS additionally verifies via EXISTS that this project belongs to auth.uid().';

create index if not exists sp_business_profiles_user_id_idx
  on public.sp_business_profiles (user_id);

create trigger sp_business_profiles_set_updated_at
  before update on public.sp_business_profiles
  for each row execute function public.sp_set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.sp_business_profiles enable row level security;
alter table public.sp_business_profiles force row level security;

-- SELECT: row must be owned by the caller AND hang off a project the caller
-- owns. The EXISTS clause is what stops a profile that was somehow stamped with
-- a foreign project_id from ever being readable.
create policy "sp_business_profiles_select_own"
  on public.sp_business_profiles
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.sp_projects p
      where p.id = sp_business_profiles.project_id
        and p.user_id = (select auth.uid())
    )
  );

-- INSERT: scenario E. Both halves are enforced at write time. B cannot insert a
-- profile for A's project (EXISTS fails) and cannot insert a row stamped with
-- A's user_id (user_id check fails). Note the EXISTS subquery itself runs under
-- the caller's RLS context against sp_projects, so it can only ever see the
-- caller's own projects — a second, independent layer of the same guarantee.
create policy "sp_business_profiles_insert_own"
  on public.sp_business_profiles
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.sp_projects p
      where p.id = sp_business_profiles.project_id
        and p.user_id = (select auth.uid())
    )
  );

-- UPDATE: USING gates which existing rows are updatable (B sees none of A's).
-- WITH CHECK gates the post-update row, preventing an owner from re-pointing
-- their profile at a foreign project_id or re-stamping a foreign user_id.
-- This is the half that completes scenario E for the update case.
create policy "sp_business_profiles_update_own"
  on public.sp_business_profiles
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.sp_projects p
      where p.id = sp_business_profiles.project_id
        and p.user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.sp_projects p
      where p.id = sp_business_profiles.project_id
        and p.user_id = (select auth.uid())
    )
  );

create policy "sp_business_profiles_delete_own"
  on public.sp_business_profiles
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.sp_projects p
      where p.id = sp_business_profiles.project_id
        and p.user_id = (select auth.uid())
    )
  );

-- As with sp_projects: the `anon` role receives no policy, so anonymous access
-- fails closed (scenario F).
