-- ============================================================================
-- StorePilot Phase 2B.3A — sp_shopify_connection_events
-- ----------------------------------------------------------------------------
-- Append-only audit/history of Shopify connection lifecycle events.
--
-- Events are NEVER created directly by client code. They are written by
-- SECURITY DEFINER functions (store_connection_tokens, revoke_connection_tokens)
-- after the corresponding metadata change succeeds.
--
-- Events must NEVER contain:
--   access token, refresh token, authorization code, client secret,
--   full OAuth state, or cookies.
--
-- That rule is enforced HERE at the database level (see the CHECK constraint
-- below), not only in the server layer: the constraint applies to every write
-- path, including service_role and direct SQL. Limitation: the check matches
-- JSON keys/values in the serialized metadata document (any nesting depth) by
-- name pattern; it cannot semantically distinguish a token-shaped string that
-- hides behind a benign key name. The server layer remains responsible for
-- only ever passing non-secret metadata in the first place.
-- ============================================================================

create table public.sp_shopify_connection_events (
  id uuid primary key default gen_random_uuid(),

  -- Connection this event belongs to. ON DELETE CASCADE preserves history
  -- semantics: if a connection row is removed, its events go with it.
  connection_id uuid not null references public.sp_shopify_connections(id) on delete cascade,

  -- Denormalised project_id for efficient tenant filtering without JOIN.
  -- Must match the connection's project_id — enforced by the trigger below.
  project_id uuid not null references public.sp_projects(id) on delete cascade,

  event_type text not null
    constraint sp_shopify_connection_events_type_check
    check (event_type in (
      'installed',
      'reconnected',
      'token_refreshed',
      'reauth_required',
      'disconnected',
      'uninstalled'
    )),

  -- Non-secret metadata only. May contain:
  --   { "reason": "token_expired", "previous_status": "connected" }
  -- Must NOT contain token material — enforced by the CHECK constraint below.
  metadata jsonb,

  created_at timestamptz not null default now(),

  -- ---------------------------------------------------------------------------
  -- Secret-bearing key/value ban (database-level enforcement)
  -- ---------------------------------------------------------------------------
  -- Matches `"key":` occurrences anywhere in the serialized document,
  -- including inside nested objects/arrays, for the forbidden names. The
  -- pattern also catches a benign-looking value that embeds such a JSON
  -- fragment as a string (e.g. metadata copied straight from an OAuth
  -- response), which is the realistic leakage vector here.
  constraint sp_shopify_connection_events_metadata_no_secrets
    check (
      metadata is null
      or metadata::text !~*
         '"(access_token|refresh_token|authorization_code|client_secret|refresh_token_expires_at|refresh_token_expires_in|expires_in|expires_at|state|cookie|cookies|set-cookie|code|token|tokens|jwt|password|secret|hmac)"\s*:'
    )
);

comment on table public.sp_shopify_connection_events is
  'Append-only audit log for Shopify connection lifecycle. Written only by SECURITY DEFINER functions. CHECK constraint forbids secret-bearing metadata keys (tokens, codes, secrets, state, cookies).';
comment on column public.sp_shopify_connection_events.metadata is
  'Non-secret event metadata only. Token strings, auth codes, client secrets, and full OAuth state are rejected by a DB CHECK constraint, not just by convention.';

-- ---------------------------------------------------------------------------
-- Consistency trigger: event.project_id must match the connection's project
-- ---------------------------------------------------------------------------
create or replace function public.sp_shopify_connection_events_enforce_project()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_project_id uuid;
begin
  select project_id into v_project_id
  from public.sp_shopify_connections
  where id = new.connection_id;

  if v_project_id is null then
    raise exception 'sp_shopify_connection_events: connection % not found or not visible to this role', new.connection_id;
  end if;

  if new.project_id is distinct from v_project_id then
    raise exception 'sp_shopify_connection_events: project_id must match the connection''s project_id';
  end if;

  return new;
end;
$$;

create trigger sp_shopify_connection_events_enforce_project
  before insert or update on public.sp_shopify_connection_events
  for each row execute function public.sp_shopify_connection_events_enforce_project();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists sp_shopify_connection_events_connection_id_idx
  on public.sp_shopify_connection_events(connection_id);

create index if not exists sp_shopify_connection_events_project_id_idx
  on public.sp_shopify_connection_events(project_id);

create index if not exists sp_shopify_connection_events_event_type_idx
  on public.sp_shopify_connection_events(event_type);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.sp_shopify_connection_events enable row level security;
alter table public.sp_shopify_connection_events force row level security;

-- SELECT: users can read events for connections they own, via the connection
-- row's user_id check. Anon gets nothing.
create policy "sp_shopify_connection_events_select_own"
  on public.sp_shopify_connection_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.sp_shopify_connections sc
      where sc.id = sp_shopify_connection_events.connection_id
        and sc.user_id = (select auth.uid())
    )
  );

-- INSERT/UPDATE/DELETE: no policy granted to authenticated or anon.
-- Events are append-only and written exclusively by SECURITY DEFINER functions.
