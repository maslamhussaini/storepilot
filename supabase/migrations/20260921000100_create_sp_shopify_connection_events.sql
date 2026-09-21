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
-- ============================================================================

create table public.sp_shopify_connection_events (
  id uuid primary key default gen_random_uuid(),

  -- Connection this event belongs to. ON DELETE CASCADE preserves history
  -- semantics: if a connection row is removed, its events go with it.
  connection_id uuid not null references public.sp_shopify_connections(id) on delete cascade,

  -- Denormalised project_id for efficient tenant filtering without JOIN.
  -- Must match the connection's project_id — enforced by trigger or function.
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
  -- Must NOT contain token material (enforced in server layer, documented).
  metadata jsonb,

  created_at timestamptz not null default now()
);

comment on table public.sp_shopify_connection_events is
  'Append-only audit log for Shopify connection lifecycle. Written only by SECURITY DEFINER functions. Never contains token material.';
comment on column public.sp_shopify_connection_events.metadata is
  'Non-secret event metadata only. Token strings, auth codes, client secrets, and full OAuth state are explicitly forbidden here.';

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
