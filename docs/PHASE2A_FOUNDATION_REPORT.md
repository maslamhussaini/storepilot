# StorePilot — Phase 2A Foundation Report

**Authenticated, multi-tenant application foundation (Supabase Auth + Postgres + RLS)**

| | |
|---|---|
| **Baseline commit** | `2025ee93f3f9907f188a2df01805f02bbc78ec19` — *"feat: complete StorePilot Phase 1 UI foundation"* |
| **Working tree at start** | Clean (only untracked `.vscode/`, left untouched) |
| **Git state at end** | **Nothing staged, nothing committed, nothing pushed** |
| **Framework** | Next.js 16.3.5 (App Router, Turbopack), React 19.2.8, TypeScript 5, Tailwind v4 |
| **Scope boundary** | No Shopify OAuth/API, no CSV/XLSX parsing, no AI, no build queue, no billing, no redesign |

---

## 1. Executive summary

StorePilot is no longer a demo shell. It now has real accounts, real per-user data, and
database-enforced tenant isolation.

* Email/password **sign-up, sign-in and sign-out** via Supabase Auth, with the
  email-confirmation-required flow handled honestly.
* **Server-verified route protection** — unauthenticated requests to the dashboard or
  wizard are redirected at the proxy layer before any protected component renders
  (measured: a 6-byte body, zero protected markup).
* The dashboard lists the signed-in user's **real `sp_projects` rows**.
* **"+ New Store"** creates a real project row owned by the session user and redirects into
  the wizard addressed by that project's id.
* The **Business step persists** to `sp_business_profiles` and advances the wizard.
* **Refresh and resume work**: wizard position and business data are reloaded from Postgres,
  and the dashboard's "Continue" deep-links to the persisted step.
* **Row Level Security** is enabled and forced on both tables, with every policy deriving
  ownership from `auth.uid()`.

Catalog, Blueprint, Build and Launch remain Phase 1 demo functionality, now carrying real
project context and each labelled with a visible **"Demo step."** notice.

### Headline verification results

| Check | Result |
|---|---|
| `npm run check:css` | **PASS** (exit 0) |
| `npm run lint` | **PASS** (exit 0) |
| `npx tsc --noEmit` | **PASS** (exit 0) |
| `npm run build` | **PASS** (exit 0) |
| RLS security suite A–G | **25/25 PASS — EXECUTED** against local Postgres |
| Refresh/resume acceptance | **PASS — EXECUTED** (24/24 data-path + live HTTP against the running app) |
| Service-role key in client bundle | **None** |

---

## 2. Dependencies added

| Package | Version | Why |
|---|---|---|
| `@supabase/supabase-js` | ^2.116.0 | Supabase client |
| `@supabase/ssr` | ^0.12.7 | Current, non-deprecated cookie-based session handling for the App Router. The deprecated `@supabase/auth-helpers-nextjs` was **not** used. |
| `server-only` | ^0.0.1 | Build-time guard: makes it an error for a Client Component to import the server data layer |

Nothing else was added. No Python, no second backend.

---

## 3. A Next.js 16 breaking change: `middleware.ts` → `proxy.ts`

The task specified `src/middleware.ts`. **That file convention is deprecated in this version
of Next.js.** Per the bundled docs at
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`:

> The `middleware.js` file convention has been **deprecated** in Next.js 16 and renamed to
> `proxy.js`. All functionality remains the same — only the file and export names have changed.

The implementation therefore lives at **`src/proxy.ts`** exporting a function named `proxy`.
This is the same feature under its current name, and the build output confirms it is active:

```
ƒ Proxy (Middleware)
```

Also honoured from the same doc — a warning that shaped the architecture:

> Always verify authentication and authorization inside each Server Function rather than
> relying on Proxy alone.

Accordingly the proxy is treated as a **UX convenience, not the security boundary**. Every
server action and every query independently re-reads the user from the session, and RLS
enforces tenancy in Postgres beneath both.

---

## 4. Database schema

Migrations use standard Supabase CLI timestamp naming and live in `supabase/migrations/`:

| File | Contents |
|---|---|
| `20260917120000_create_sp_projects.sql` | `sp_set_updated_at()` trigger function, `sp_projects`, index, trigger, RLS + 4 policies |
| `20260917120100_create_sp_business_profiles.sql` | `sp_business_profiles`, unique constraint, index, trigger, RLS + 4 policies |

Both applied cleanly against a local Supabase instance (output in §8), and were subsequently
applied to the dedicated StorePilot Supabase Cloud project (ref `nchxfngytvchlnlogeuy`) via the
Supabase MCP server's `apply_migration`, one at a time with schema verification between them —
see §15 for the cloud-specific results.

### 4.1 `sp_projects`

The tenancy root — one store-launch effort, owned by exactly one user.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `user_id` | `uuid NOT NULL` | → `auth.users(id)` **ON DELETE CASCADE** |
| `name` | `text NOT NULL` | default `'Untitled Store'` |
| `status` | `text NOT NULL` | default `'draft'`; CHECK ∈ `draft, in_progress, ready, archived` |
| `current_step` | `text NOT NULL` | default `'connect'`; CHECK ∈ the six wizard keys |
| `progress_percent` | `smallint NOT NULL` | default `0`; CHECK `0..100` |
| `industry`, `country_code`, `currency_code`, `primary_language` | `text` | denormalised summary (see §4.3) |
| `created_at`, `updated_at` | `timestamptz NOT NULL` | `updated_at` maintained by trigger |

**Status vocabulary — why four values.** `status` is deliberately coarse rather than one
value per wizard step. `current_step` already carries step granularity; duplicating it in
`status` would create two sources of truth that drift. `draft` = created but nothing
meaningful entered; `in_progress` = real data supplied; `ready` = wizard completed;
`archived` = hidden from the dashboard but retained.

**`updated_at` via trigger, not application code**, so a client can neither forge nor forget it.

### 4.2 `sp_business_profiles`

Durable output of the Business step. **Exactly one row per project**, enforced by
`UNIQUE (project_id)` — which is also the `ON CONFLICT` target for the upsert.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `project_id` | `uuid NOT NULL` | → `sp_projects(id)` **ON DELETE CASCADE**, **UNIQUE** |
| `user_id` | `uuid NOT NULL` | → `auth.users(id)` **ON DELETE CASCADE** |
| `business_name`, `description` | `text NOT NULL` | default `''` |
| `industry`, `country_code`, `brand_style`, `logo_url`, `secondary_language` | `text` | nullable |
| `currency_code`, `primary_language` | `text NOT NULL` | default `'USD'` / `'en'` |
| `created_at`, `updated_at` | `timestamptz NOT NULL` | trigger-maintained |

**Why both `project_id` and `user_id` are stored.** This is deliberate denormalisation *for
security*. `user_id` lets the RLS policy check row ownership directly without a join on
every statement; `project_id` is additionally validated against `sp_projects` ownership via
an `EXISTS` subquery. **Both checks must pass, and either alone is insufficient:**

* `user_id` alone would let User B attach a profile (owned by B) to User A's project.
* `project_id` alone would let User B write a row stamped with A's `user_id`.

Both holes are covered by tests E.1 and E.2, which pass.

### 4.3 Cascade behaviour — documented choices

| Relationship | Behaviour | Rationale |
|---|---|---|
| `auth.users` → `sp_projects` | CASCADE | Projects are meaningless without their owner. Orphans would be a GDPR-deletion problem *and* an RLS hazard: rows whose `user_id` matches no live user are unreachable but still stored. |
| `sp_projects` → `sp_business_profiles` | CASCADE | The profile is a detail record of the project with no standalone meaning. |
| `auth.users` → `sp_business_profiles` | CASCADE | Redundant in practice (deletion already cascades through the project) but declared explicitly so "no row outlives its owner" holds even if the project FK is later relaxed. |

### 4.4 The denormalised summary columns — a deliberate sync, not drift

`industry`, `country_code`, `currency_code` and `primary_language` exist on **both** tables.
This is safe because **`saveBusinessProfileAction` is the only writer of those four columns
on `sp_projects`**. They are never edited independently, so there is no code path by which
they can drift. The dashboard card renders industry and currency without a join.

If a second writer is ever introduced, this should be replaced with a trigger on
`sp_business_profiles`. That condition is recorded as a comment in the migration.

---

## 5. RLS policies — verbatim

RLS is **enabled and forced** on both tables:

```sql
alter table public.sp_projects enable row level security;
alter table public.sp_projects force row level security;
```

`FORCE` is belt-and-braces: it makes the policies apply even to the table owner, so a future
`SECURITY DEFINER` function or a migration running as the owner cannot silently bypass tenancy.

### 5.1 Policy inventory

| Policy | Table | Purpose (one line) |
|---|---|---|
| `sp_projects_select_own` | `sp_projects` | A user can read only their own projects; a forged id matches nothing. |
| `sp_projects_insert_own` | `sp_projects` | `WITH CHECK` rejects any row whose `user_id` is not the caller. |
| `sp_projects_update_own` | `sp_projects` | Only own rows are updatable, and ownership cannot be reassigned away. |
| `sp_projects_delete_own` | `sp_projects` | Only own rows are deletable. |
| `sp_business_profiles_select_own` | `sp_business_profiles` | Row must be owned by the caller **and** hang off a project the caller owns. |
| `sp_business_profiles_insert_own` | `sp_business_profiles` | Blocks both forged `user_id` and foreign `project_id` at write time. |
| `sp_business_profiles_update_own` | `sp_business_profiles` | Gates existing rows *and* the post-update row (no re-pointing at a foreign project). |
| `sp_business_profiles_delete_own` | `sp_business_profiles` | Same double ownership check for deletes. |

**No policy is granted to the `anon` role on either table.** With RLS enabled and zero
applicable policies, every anonymous statement fails closed.

### 5.2 `sp_projects` — verbatim

```sql
create policy "sp_projects_select_own"
  on public.sp_projects
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "sp_projects_insert_own"
  on public.sp_projects
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "sp_projects_update_own"
  on public.sp_projects
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "sp_projects_delete_own"
  on public.sp_projects
  for delete
  to authenticated
  using (user_id = (select auth.uid()));
```

**What each clause enforces.** `USING` decides which existing rows the statement can *see*;
`WITH CHECK` validates the row being *written*. For SELECT/DELETE, `USING` is sufficient and a
cross-tenant attempt degrades to **0 rows affected** rather than an error — it fails closed
and leaks nothing about whether the id exists. For INSERT, `WITH CHECK` is the important
half: it rejects a client that submits someone else's `user_id`. For UPDATE, both are needed
— `USING` stops B touching A's rows, and `WITH CHECK` stops an owner from *giving their
project away* by rewriting `user_id` (tested by E.6).

`(select auth.uid())` rather than bare `auth.uid()` lets Postgres evaluate the function once
per statement instead of once per row.

### 5.3 `sp_business_profiles` — verbatim (SELECT and INSERT shown; UPDATE/DELETE use the same predicate)

```sql
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
```

The `EXISTS` subquery is what stops a malicious user attaching a business profile to another
tenant's project even if they guess or forge a `project_id`. Note that the subquery *itself*
runs under the caller's RLS context against `sp_projects`, so it can only ever see the
caller's own projects — a second, independent layer of the same guarantee.

The UPDATE policy repeats the predicate in **both** `USING` and `WITH CHECK`, which is what
prevents an owner re-pointing their own profile at someone else's project (tested by E.5).

---

## 6. Auth & session architecture

```
Browser
  │  cookies (HttpOnly, set server-side)
  ▼
src/proxy.ts ............ refreshes the Supabase session on every matched request;
                          redirects anon → /login and authed → / off /login,/signup
  ▼
Server Components / Server Actions
  │
  ├── src/lib/supabase/server.ts ... createServerClient bound to next/headers cookies
  ├── src/lib/auth/dal.ts .......... getAuth() / requireUser()  [react cache()]
  └── src/lib/projects/queries.ts .. listProjects(), getProjectWithProfile()
  ▼
Postgres + RLS ......... the actual security boundary
```

**Design rules held throughout:**

1. **`getUser()`, never `getSession()`** for any authorization decision. `getSession()` merely
   decodes the cookie the browser sent, which a client can forge; `getUser()` revalidates the
   JWT with the auth server.
2. **The service-role key is never used.** It bypasses RLS entirely. Every operation runs
   through the calling user's own session so RLS stays in force. `SUPABASE_SERVICE_ROLE_KEY`
   appears in `.env.example` (documented for future server-only admin tooling) and in exactly
   one explanatory comment — it is read by no code.
3. **Ownership is never a parameter.** No query or action accepts a `userId`. There is
   literally no way to express "fetch someone else's data".
4. **`import "server-only"`** in `server.ts`, `dal.ts` and `queries.ts` makes a Client
   Component importing them a build error.
5. **Cookie writes are swallowed in Server Components** (they are read-only there) — correct
   per the Supabase SSR pattern, because `proxy.ts` performs the actual refresh so the rotated
   token is never lost.

### Email confirmation is handled honestly

`signUpAction` inspects the result:

* `data.session === null` → confirmation is required. The UI **replaces the form** with
  *"Check your inbox — we've sent a confirmation link to …"*. It never claims the user is
  logged in.
* `data.session` present → confirmation is off; cookies are already set, redirect to `/`.
* An existing address returns a user with **zero identities** (Supabase's anti-enumeration
  behaviour). We show the identical "check your inbox" message so the form reveals nothing.

Login errors likewise never distinguish "no such account" from "wrong password", which would
turn the form into an account-enumeration oracle. The one exception is the genuinely
actionable `email_not_confirmed`, which tells the user to check their inbox.

`?next=` is validated on both the page and the action: only relative same-site paths are
accepted (`//evil.com` rejected), closing an open-redirect hole.

---

## 7. Route architecture

| Route | Type | Purpose |
|---|---|---|
| `/` | ƒ dynamic | Dashboard — the user's real projects. Protected. |
| `/login` | ƒ dynamic | Sign in (reads `?next=`). Public. |
| `/signup` | ○ static | Create account. Public. |
| `/projects/[projectId]` | ƒ dynamic | Redirects to the wizard resume link. |
| `/projects/[projectId]/wizard` | ƒ dynamic | **Resume entry point** — redirects to the persisted `current_step`. |
| `/projects/[projectId]/wizard/[step]` | ƒ dynamic | The six wizard steps, project-scoped. |
| `/_not-found`, `error.tsx` | — | Friendly 404 and error boundary. |

**Why `/projects/[projectId]/wizard/[step]`.** The project id is the tenancy root, so it
belongs at the front of the path: every segment beneath it is unambiguously scoped to one
project, and future project-level surfaces (`/projects/[id]/settings`) need no restructuring.
The Phase 1 global `/wizard/[step]` route was **removed** — it had nowhere to put ownership.

Every protected route is `ƒ` (server-rendered on demand). Nothing protected is prerendered or
cached, verified in the build output.

`/projects/[projectId]/wizard` being a stable "take me back to where I was" URL is what makes
the dashboard's **Continue** link survive sessions and devices.

---

## 8. Tests — EXECUTED vs PREPARED

> The distinction below is exact. A local Supabase stack **was** available in this
> environment, so the security suite and the acceptance test were genuinely run.

### 8.1 Environment — what was actually available

| Tool | Status |
|---|---|
| Supabase CLI | **Present**, v2.116.0 |
| Docker | **Present**, v28.5.1 (Docker Desktop started during the session) |
| Local Supabase stack | **Started successfully**, with caveats below |
| Hosted Supabase project | **Not available** — no credentials |

`supabase start` initially **failed**: the `edge-runtime` image could not be pulled
(`short read: expected 18661409 bytes but got 18189887: unexpected EOF`, then registry
timeouts). Since the RLS tests need only Postgres, the stack was restarted with the
non-essential services excluded:

```
npx supabase start -x edge-runtime,studio,imgproxy,storage-api,logflare,vector,supavisor,realtime,inbucket,pgbouncer
```

This succeeded, and **both migrations applied**:

```
Starting database...
Initialising schema...
Seeding globals from roles.sql...
Applying migration 20260917120000_create_sp_projects.sql...
Applying migration 20260917120100_create_sp_business_profiles.sql...
```

Running containers: `supabase_db`, `supabase_auth`, `supabase_rest`, `supabase_kong`,
`supabase_pg_meta`, `supabase_inbucket` — i.e. **full auth + database + REST**, which is
everything the application uses.

### 8.2 RLS security suite — **EXECUTED**

Script: **`supabase/tests/rls_security_tests.sql`**

Runs entirely inside one transaction ending in `ROLLBACK`, so it persists nothing (not even
the two test users) and is safe to re-run against a live database. Every assertion runs as a
real `authenticated` / `anon` Postgres role with a forged-but-well-formed JWT claim set —
never as a superuser, which would bypass RLS and make the suite vacuously pass.

Command:

```bash
docker exec -i supabase_db_storepilot \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < supabase/tests/rls_security_tests.sql
```

**Result: 25/25 PASS, exit code 0.** Actual output:

```
PASS [A.1 User A can CREATE and then SELECT their own project]
PASS [A.2 User A can UPDATE their own project (wizard progress persists)]
PASS [A.3 User A can CREATE a business profile on their own project]
PASS [A.4 UNIQUE(project_id) blocks a second business profile]
PASS [B.1 User B CANNOT SELECT User A's project (0 rows, not an error - fails closed)]
PASS [B.2 An unfiltered SELECT by User B returns none of User A's rows]
PASS [B.3 User B CANNOT SELECT User A's business profile]
PASS [C.1 User B's UPDATE of User A's project affects 0 rows]
PASS [D.1 User B's DELETE of User A's project affects 0 rows]
PASS [E.1 B CANNOT attach a profile to A's project (RLS WITH CHECK / EXISTS)]
PASS [E.2 B CANNOT forge A's user_id on insert (RLS WITH CHECK)]
PASS [E.3 User B's UPDATE of User A's business profile affects 0 rows]
PASS [E.4 Control: User B CAN create their own project + profile, and sees exactly 1 of each]
PASS [E.5 B CANNOT re-point their own profile at A's project]
PASS [E.6 B CANNOT reassign project ownership to another user]
PASS [F.1 Anonymous SELECT on sp_projects returns 0 rows (no policy for anon)]
PASS [F.2 Anonymous SELECT on sp_business_profiles returns 0 rows]
PASS [F.3 Anonymous INSERT into sp_projects is denied]
PASS [G.1 B fetching A's real project id (the URL-tampering path) yields 0 rows]
PASS [G.2 B fetching a random non-existent project id yields 0 rows (indistinguishable from G.1)]
PASS [H.1 RLS is ENABLED and FORCED on both sp_projects and sp_business_profiles]
PASS [H.2 sp_projects has exactly 4 policies (select/insert/update/delete)]
PASS [H.3 sp_business_profiles has exactly 4 policies]
PASS [H.4 No policy on either table is granted to the anon role]
PASS [H.5 Every policy derives ownership from auth.uid() (no broad authenticated-only policy)]
=== ALL RLS TESTS PASSED (A-H) ===
```

Coverage against the required scenarios:

| Required | Covered by | Result |
|---|---|---|
| A. User A can create/read/update own project | A.1, A.2, A.3 | **EXECUTED — PASS** |
| B. User B cannot read A's project | B.1, B.2, B.3 | **EXECUTED — PASS** |
| C. User B cannot update A's project | C.1 | **EXECUTED — PASS** |
| D. User B cannot delete A's project | D.1 | **EXECUTED — PASS** |
| E. User B cannot create/update a profile on A's project | E.1, E.2, E.3, E.5 | **EXECUTED — PASS** |
| F. Anonymous cannot access protected data | F.1, F.2, F.3 | **EXECUTED — PASS** |
| G. Manipulating `projectId` exposes nothing | G.1, G.2 | **EXECUTED — PASS** |

### 8.3 Negative control — proof the suite is not vacuous

A suite that denied everything would also "pass" A–G. To prove the assertions have teeth, RLS
was deliberately disabled on `sp_projects` inside a rolled-back transaction and B.1 re-checked:

```
NOTICE:  NEGATIVE CONTROL OK: with RLS disabled, User B sees 1 of User A's rows
         -> B.1 would FAIL as intended
```

The suite detects the regression it claims to detect. Test E.4 covers the mirror-image risk by
asserting User B *can* still operate normally in their own tenant.

### 8.4 Refresh/resume acceptance test — **EXECUTED**

Run in two complementary layers. Both passed.

**Layer 1 — data-path lifecycle (24/24 PASS, exit 0).** A Node script using
`@supabase/supabase-js` with real JWTs against the live local stack, reproducing exactly what
the server actions do. Each "fresh client" stands in for a browser refresh or a new login:
nothing carries over in memory, every read goes back to Postgres.

```
PASS [1. Sign up creates an account]
PASS [1b. Local project returns a session (email confirmation disabled)]
PASS [2. Create project row]
PASS [2b. Defaults applied] — current_step=connect progress=0 status=draft
PASS [3. Upsert business profile]
PASS [3b. Advance wizard to 'catalog' + mirror summary columns]
PASS [4. After refresh, wizard position restored] — current_step=catalog
PASS [4b. Progress restored] — progress=33
PASS [4c. Business name restored] — Royal Oud
PASS [4d. Industry restored] — beauty
PASS [4e. Brand style restored] — luxury
PASS [4f. Secondary language restored] — ar
PASS [4g. Denormalised summary columns synced on sp_projects] — industry=beauty currency=AED
PASS [5. Dashboard lists exactly the user's own project] — count=1
PASS [5b. Card shows saved business name] — Royal Oud
PASS [5c. 'Continue' deep-links to the persisted step]
PASS [6. Re-saving Business step updates in place (still 1 profile row)] — count=1
PASS [7. User B cannot READ User A's project via a tampered projectId]
PASS [7b. User B cannot UPDATE User A's project]
PASS [7c. User B cannot DELETE User A's project]
PASS [7d. User B cannot ATTACH a business profile to User A's project]
       — new row violates row-level security policy for table "sp_business_profiles"
PASS [8. Anonymous client reads no project data]
PASS [9. User A's project intact after B's attack attempts] — name=Royal Oud step=catalog progress=33
PASS [9b. User A's business profile intact and reflects the latest save]
ALL ACCEPTANCE CHECKS PASSED
```

**Layer 2 — live HTTP against the running production build.** `npm run build && next start`,
then requests carrying genuine `@supabase/ssr` session cookies (generated with the same
library the app uses, so the cookie names and encoding are identical to a real browser's).

*Unauthenticated:*

```
GET /                                   -> 307 -> /login
GET /projects/<uuid>/wizard/business    -> 307 -> /login?next=%2Fprojects%2F...%2Fbusiness
GET /login                              -> 200
GET /signup                             -> 200
Body bytes returned for / : 6
"Launch your next store" occurrences : 0
"Sign out" occurrences               : 0
```

→ Protection is genuinely server-side. **No flash of protected content** — the redirect
carries a 6-byte body containing none of the dashboard.

*Authenticated as User A:*

```
GET /login                       -> 307 -> /            (authed users bounced off auth pages)
GET /signup                      -> 307 -> /
GET /                            -> 200
GET /projects/<A>/wizard         -> 307 -> /projects/<A>/wizard/catalog   ← persisted step
```

*Dashboard content:* `"Royal Oud"` ×2, `"Continue"` ×2, `"Sign out"` ×2, `"33%"` ×4,
`"No stores yet"` ×0, deep-link to `/wizard/catalog` present, **User B's project id: 0 occurrences**.

*Business step restores saved data:* `value="Royal Oud"` present, industry and brand-style
tiles rendered with `aria-pressed="true"` ×2.

*Cross-tenant URL tampering (scenario G, live):* User A requesting **User B's** project:

```
GET /projects/<B>/wizard/business  -> 200
"We couldn't find that store"      -> 1 occurrence
"B Store" (B's real store name)    -> 0 occurrences
```

*Brand-new user:* `"No stores yet."` ×2, `"Build Your First Store"` ×2, `"Royal Oud"` ×0.

**What this covers vs. the scripted acceptance test:** sign-up → create project → enter
Business data → Continue → refresh → data remains → log in again → dashboard shows project →
Continue → correct step opens → Business data restored. **All of it passed.**

**What was NOT executed:** no GUI browser automation (Playwright/Puppeteer) was run, so
mouse-level interaction, client-side JS hydration behaviour and visual rendering were not
machine-verified. The assertions above are made against real server-rendered HTML from the
production build over HTTP, not against a screenshot or a DOM snapshot.

### 8.5 Summary table

| Item | Status |
|---|---|
| RLS suite A–G (25 assertions) | **EXECUTED — 25/25 PASS** |
| Negative control (suite catches disabled RLS) | **EXECUTED — PASS** |
| Data-path refresh/resume (24 assertions) | **EXECUTED — 24/24 PASS** |
| Live HTTP route protection + cross-tenant + empty state | **EXECUTED — PASS** |
| Secret-leak audit of built client bundle | **EXECUTED — PASS** |
| Browser GUI / visual regression automation | **NOT EXECUTED** — no browser automation in this environment; visual parity spot-checked by code review (§10) |
| Hosted Supabase project verification | **NOT EXECUTED** — no hosted credentials. The same SQL suite is the deliverable for CI/staging; run it with `psql "$SUPABASE_DB_URL" -f supabase/tests/rls_security_tests.sql`. |
| Real email delivery / confirmation click-through | **NOT EXECUTED** — local stack ran with email confirmation disabled, so the confirmation branch was verified by code review, not by receiving an email. |

---

## 9. Quality gate — exact results

All four run on the final code.

```
$ npm run check:css
check:css passed — scanned 53 source file(s), no malformed placeholder candidates found.
EXIT=0

  (The success line is paraphrased here on purpose. Quoting the guard's own
   output verbatim would embed the very placeholder token it scans docs/ for,
   which fails the check — the exact trap that produced this bug twice in
   Phase 1B. See scripts/check-css.mjs.)

$ npm run lint
EXIT=0                      (eslint, no warnings, no errors)

$ npx tsc --noEmit
EXIT=0                      (no output)

$ npm run build
✓ Compiled successfully
Route (app)
┌ ƒ /
├ ○ /_not-found
├ ƒ /login
├ ƒ /projects/[projectId]
├ ƒ /projects/[projectId]/wizard
├ ƒ /projects/[projectId]/wizard/[step]
└ ○ /signup
ƒ Proxy (Middleware)
BUILD_EXIT=0
```

### Two real bugs the gate caught

1. **Every database table silently typed as `never`.** `SpProject` and `SpBusinessProfile`
   were declared as `interface`. Interfaces do not satisfy supabase-js's
   `Record<string, unknown>` constraint (type aliases do), so the whole `Database` schema
   failed the constraint and `.from("sp_projects")` degraded to `never`. **Reads appeared to
   compile fine** — `never` is assignable to anything — while writes failed with confusing
   "Property 'id' does not exist on type 'never'" errors. Fixed by converting both to type
   aliases and adding the required `Relationships` key. Without this fix the query layer had
   no type safety at all.

2. **`"use server"` modules may only export async functions.** Exporting the `idleState`
   object from an actions file broke `next build`
   ([invalid-use-server-value](https://nextjs.org/docs/messages/invalid-use-server-value)).
   Fixed by extracting shared form state into `src/lib/forms/state.ts`.

---

## 10. Security verification

| Check | Method | Result |
|---|---|---|
| RLS enabled **and forced** on both tables | Asserted from `pg_class` in the live DB (H.1) | **PASS** |
| Exactly 4 policies per table | `pg_policies` count (H.2, H.3) | **PASS** |
| No policy granted to `anon` | `pg_policies` role inspection (H.4) | **PASS** |
| Every policy derives ownership from `auth.uid()` | Regex over `pg_policies.qual`/`with_check` (H.5) | **PASS** |
| No broad "any authenticated user" policy | H.5 + manual review | **PASS** |
| Service-role key absent from `src/` | `grep -rn SERVICE_ROLE src/` | Only 1 hit — an explanatory **comment**. No code reads it. |
| Service-role key absent from client bundle | `grep -rl "service_role\|sb_secret\|SERVICE_ROLE" .next/static/` | **None** |
| JWT signing secret absent from client bundle | `grep -rl "super-secret-jwt-token" .next/static/` | **None** |
| `.env*` gitignored | `git check-ignore -v .env.local` → `.gitignore:34:.env*` | **Confirmed** |
| No secret committed or staged | `git status` — `.env.local` does not appear | **Confirmed** |
| Protected routes server-verified | Live HTTP, 6-byte body, 0 protected strings | **PASS** |
| URL tampering exposes nothing | Live HTTP cross-tenant request | **PASS** |
| Open redirect via `?next=` | Code review: relative-path-only validation in page **and** action | **Mitigated** |
| Account enumeration | Code review: identical messaging for all login failures and for existing-email signup | **Mitigated** |

### Phase 1 visual identity — spot check (code review, not automated)

* `AppShell`, `WizardShell`, `WizardProgress`, `ProjectCard`, `GradientButton`, `StatusBadge`,
  `MetricCard` all retain their Phase 1 markup, class strings and CSS custom properties.
* New UI (`AuthLayout`, `FormField`, `SubmitButton`) reuses the existing tokens verbatim —
  `sp-gradient-dark`, `sp-glow-orb`, `sp-btn-primary`, `--sp-mint-*`, `--sp-emerald-*`,
  `text-[#b42318]` for errors — with no new palette introduced.
* `FormField` was extracted from the Phase 1 Business-step input *by copying its exact
  classes*, so the auth forms and the Business step cannot drift apart.
* Responsive behaviour unchanged: the same `sm:`/`md:`/`lg:` breakpoints, the desktop step
  rail still `hidden md:block`, the mobile compact progress bar still `md:hidden`.
  `AuthLayout`'s brand panel is `hidden lg:block` so the form stays above the fold on phones.
* `npm run check:css` (the Tailwind v4 malformed-`var()` regression guard) passes.

**Not automated:** no screenshot diffing or device-lab testing was performed.

### Two deliberate, visible content changes

1. **Project card, bottom-left**: shows *"Updated YYYY-MM-DD"* instead of *"842 products"*.
   Phase 2A stores no products; printing a fabricated count beside real user data would be
   misleading. Same markup slot, same classes.
2. **Dashboard metrics**: three of four are now computed from the user's real rows. "Stores
   launched" remains structurally `0` and says *"Launch is not implemented in this phase"*
   rather than inventing a number.

---

## 11. Failure UX

No raw database error is ever shown to a merchant. Server-side causes are logged with a
`[scope]` prefix; the user sees a calm, on-brand message.

| Failure | Handling |
|---|---|
| Supabase not configured | `getSupabaseEnv()` returns `null`; auth pages render *"StorePilot isn't able to reach its servers right now."* The build still succeeds with no `.env.local`. |
| Supabase unreachable / outage | `getAuth()` returns `unavailable` — deliberately distinct from `anonymous`, so the user is **not** bounced to `/login`, which would be a confusing lie. Dashboard and wizard show *"We're having trouble… Your work is safe."* |
| Session expired / revoked in another tab | `SessionWatcher` subscribes to `onAuthStateChange` and calls `router.refresh()`, so the server re-evaluates and redirects cleanly. |
| Project not found | *"We couldn't find that store"* + Back to dashboard. |
| Unauthorized project access | **Identical** to "not found" — distinguishing them would leak the existence of other tenants' ids. |
| Save failure | Inline `FormAlert`: *"We couldn't save your changes just now…"*; entered values are preserved. |
| Duplicate submission | `useFormStatus` disables the button while pending; server-side, `createProjectAction` reuses any untouched draft created in the last 15s, so a double-click or a retried POST lands in the same project. |
| Network delay | Every submit button shows a pending label (*"Saving…"*, *"Creating…"*) with `aria-busy`. |
| Unexpected crash | `src/app/error.tsx` boundary with a correlation `digest`, *Try again* and *Back to dashboard*. |
| Bad step key in URL | `notFound()` → friendly 404. |

---

## 12. Files changed

**Added — database & tests**
```
supabase/config.toml
supabase/migrations/20260917120000_create_sp_projects.sql
supabase/migrations/20260917120100_create_sp_business_profiles.sql
supabase/tests/rls_security_tests.sql
.env.example
```

**Added — application**
```
src/proxy.ts                                  Session refresh + route protection (Next 16 name)
src/lib/supabase/env.ts                       NEXT_PUBLIC_* access; never the service-role key
src/lib/supabase/server.ts                    Server client (server-only)
src/lib/supabase/client.ts                    Browser client (SessionWatcher only)
src/lib/supabase/types.ts                     Hand-maintained Database types
src/lib/auth/dal.ts                           getAuth / requireUser / userInitials
src/lib/auth/actions.ts                       signIn / signUp / signOut
src/lib/projects/queries.ts                   listProjects / getProjectWithProfile
src/lib/projects/actions.ts                   create / saveBusinessProfile / advanceWizard
src/lib/projects/view.ts                      Row → card view model
src/lib/projects/ids.ts                       UUID validation
src/lib/forms/state.ts                        Shared ActionState (outside "use server")
src/lib/wizard/steps.ts                       Step definitions (moved out of the route folder)
src/app/login/page.tsx
src/app/signup/page.tsx
src/app/error.tsx
src/app/not-found.tsx
src/app/projects/[projectId]/page.tsx
src/app/projects/[projectId]/wizard/page.tsx
src/app/projects/[projectId]/wizard/[step]/page.tsx
src/app/projects/[projectId]/wizard/[step]/WizardStepView.tsx
src/components/AuthLayout.tsx
src/components/AuthForm.tsx
src/components/FormField.tsx                  FormField + FormAlert
src/components/SubmitButton.tsx
src/components/SessionWatcher.tsx
```

**Modified**
```
src/app/page.tsx              Dashboard now renders real sp_projects rows
src/components/AppShell.tsx   Real user chip, sign-out, "+ New Store" as a mutation form
src/components/ProjectCard.tsx  Same markup; real data; deep-links to persisted step
src/components/WizardShell.tsx  Takes projectId + furthestStep
src/components/WizardProgress.tsx  Project-scoped links; unreached steps non-interactive
src/data/projects.ts          Marked PHASE 1 DEMO FIXTURES; exports renamed devOnly*
package.json / package-lock.json
```

**Deleted**
```
src/app/wizard/**             Global, project-less wizard — no way to express ownership
src/lib/supabase/index.ts     Phase 1 stub, superseded
```

**Isolation of the Phase 1 mock data.** `src/data/projects.ts` carries a prominent header
banner and its value exports are renamed `devOnlyDemoProjects` / `devOnlyDashboardMetrics`, so
an accidental import is obvious in review. Verified: `grep -rn "devOnly" src/app src/components`
returns **no hits**. The only remaining reference anywhere is a `DashboardMetric` *type* import
in `MetricCard.tsx`, which is erased at compile time and carries no data.

`WizardContext` was **removed** rather than kept. With durable data coming from the server as
props and ephemeral animation state living in the step components that own it, a global
provider would have been dead weight — and a tempting place to reintroduce client-side
"persistence" that silently loses data on refresh.

---

## 13. Known limitations

1. **Connect, Catalog, Blueprint, Build and Launch persist nothing.** They carry real project
   context and each shows a visible **"Demo step."** notice, but no Shopify call, file parse,
   blueprint generation or build job exists. Build progress restarts on every mount by design.
2. **No product storage.** There is no products table, so the card shows a date rather than a
   count.
3. **No password reset, email change, OAuth or MFA.** Email/password only.
4. **Email confirmation not exercised end-to-end.** The local stack ran with confirmations
   disabled; the confirmation branch is implemented and reviewed but no confirmation email was
   received and clicked.
5. **`progress_percent` is derived from step position**, not from real completion signals.
6. **No `archived` UI.** The status exists and the dashboard filters on it; nothing sets it yet.
7. **Database types are hand-maintained.** Regenerate with
   `npx supabase gen types typescript --local` once a canonical project exists.
8. **`updated_at` ordering on the dashboard** reflects any write, including a wizard step
   change — not only meaningful content edits.
9. **No rate limiting of our own** beyond Supabase's built-in auth limits.
10. **No automated browser/visual regression tests**, and no CI wiring for the SQL suite yet.
11. **The local Supabase stack ran without `edge-runtime`, `storage`, `realtime` and `studio`**
    due to an image-pull failure. None are used by Phase 2A, but a full-stack run has not been
    demonstrated in this environment.

---

## 14. Recommended next phase

### Phase 2B — Real Shopify OAuth & store connection

**Not implemented here, and explicitly out of scope for Phase 2A.** It is the natural next
step because the Connect step is currently the only wizard stage that is both first in the
flow and entirely fake, and everything downstream (catalog import, blueprint, build) needs a
real store handle and access token before it can become real.

Suggested Phase 2B scope:

1. Shopify OAuth 2.0 authorization-code flow: install/redirect route handlers, `state` nonce
   validation, HMAC verification of Shopify callbacks.
2. A new `sp_shopify_connections` table (`project_id`, `shop_domain`, encrypted access token,
   granted scopes, installed/uninstalled timestamps) under the **same** RLS ownership pattern
   established here — per-row `user_id = auth.uid()` plus an `EXISTS` check on project ownership.
3. **Encryption at rest for the access token**, via Supabase Vault or `pgsodium` — a Shopify
   token is materially more dangerous than anything stored in Phase 2A, and RLS alone is not
   sufficient protection for it.
4. Replace the demo Connect step with the real flow; persist `current_step = 'business'` on
   successful install.
5. Handle the `app/uninstalled` webhook, and the reconnect/expired-token path.
6. Extend `supabase/tests/rls_security_tests.sql` with scenarios for the new table — in
   particular that User B cannot read User A's Shopify token under any circumstance.

Phases after that, in order: **2C** real catalog ingestion (CSV/XLSX parse + field mapping,
`sp_products`), **2D** the blueprint engine, **2E** a durable build queue writing to Shopify.

## 15. Cloud deployment & real-browser acceptance (final checkpoint)

Everything in §1–14 above was originally written and verified against a local Supabase CLI
stack. This section records what changed once StorePilot was connected to a real, dedicated
Supabase Cloud project and exercised through an actual browser — the final gate before this
phase was frozen.

### 15.1 Cloud connection

- Dedicated Supabase Cloud project created for StorePilot exclusively (project ref
  `nchxfngytvchlnlogeuy`) — confirmed via `NEXT_PUBLIC_SUPABASE_URL` resolving to
  `nchxfngytvchlnlogeuy.supabase.co` and independently via the Supabase MCP server's
  `get_project_url`.
- `.env.local` was updated to the current Supabase key-naming convention. `src/lib/supabase/env.ts`
  now reads `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (Supabase's current name, an `sb_publishable_…`
  value) first, falling back to the legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` name so an older
  project's env file keeps working unchanged. `.env.example` documents both.
- A pre-deployment read-only preflight (Auth endpoint reachable, REST API reachable, public
  schema empty, migration history empty) was run and passed before any DDL was applied — full
  detail in the Phase 2A.1 conversation record; not duplicated here.

### 15.2 Migrations applied to cloud

Both approved migrations, and only those two, were applied via `apply_migration` (Supabase MCP),
in order, with schema verification after each before proceeding to the next:

1. `20260917120000_create_sp_projects` → verified: 11 columns, PK, FK to `auth.users`, all three
   CHECK constraints, index, `updated_at` trigger, RLS **enabled + forced**, exactly 4 policies.
2. `20260917120100_create_sp_business_profiles` → verified: unique `project_id`, FK to both
   `sp_projects` and `auth.users`, index, trigger, RLS enabled + forced, exactly 4 policies.

Post-deployment, `list_migrations` showed exactly these two entries — nothing else. No other
schema, table, or object was created, altered, or dropped. The pre-existing unrelated
`public.rls_auto_enable()` function flagged by the security advisor is a Supabase-platform
default present in every fresh project; it was not created, modified, or touched by either
migration.

### 15.3 Cloud RLS/security suite

`supabase/tests/rls_security_tests.sql` (scenarios A–H, unmodified except stripping the psql-only
`\set` directive) was executed **verbatim** against the cloud database via MCP `execute_sql`,
inside its own `begin … rollback`. The run completed with zero errors — since any single
assertion failure raises an exception that aborts the transaction, a clean completion is proof
every one of the **24 assertions** (A.1–A.4, B.1–B.3, C.1, D.1, E.1–E.6, F.1–F.3, G.1–G.2, H.1–H.5)
passed under real Postgres RLS enforcement, not application-layer filtering. A follow-up query
confirmed the `rollback` left zero residue (0 rows in both tables, 0 fixture users in
`auth.users`) — nothing to clean up.

### 15.4 Real-browser acceptance (manually verified)

The following was performed and confirmed manually in a real browser against the cloud project
(reported directly; not something this session could execute itself, since no browser automation
tool was available to it):

- Real signup succeeded; real email confirmation completed; real login succeeded.
- Authenticated dashboard loaded against the live cloud project.
- Business step data was saved; Continue advanced the project to Catalog.
- **Refresh persistence:** `Ctrl+R` on Catalog restored the same project at the same step; navigating
  back to Business restored the previously saved values exactly.
- Back-navigation did not destroy the persisted resume checkpoint.
- From the dashboard, opening the existing project and clicking Continue resumed at Catalog.
- **Cross-session persistence:** sign out → sign in again → dashboard → Continue resumed at
  Catalog, with Connect and Business both still showing as completed.

This closes the one gap flagged at the end of the previous cloud-verification pass (real
browser/session persistence had only been proven indirectly, through the data-path executed by
the RLS suite, because creating a fresh disposable auth user via the REST signup endpoint had hit
Supabase's email-send rate limit). It is now confirmed end-to-end, manually, in a real browser.

### 15.5 Hydration warning — investigated, not an application defect

A hydration mismatch surfaced on `/signup` during manual testing, listing attributes such as
`cz-shortcut-listen`, `data-gr-ext-installed`, `data-new-gr-c-s-check-loaded`, `bis_skin_checked`,
`bis_register`, and `__processed_<uuid>__` present on the client DOM but absent from server-rendered
HTML. These are well-known browser-extension DOM-injection signatures (ColorZilla, Grammarly, and
similar security/form-processing extensions that tag scanned elements), not React/Next.js output.
Verification performed:

- Searched the entire StorePilot source tree for all six attribute names — **zero matches**.
  StorePilot generates none of them.
- Reviewed `RootLayout`, the full `/signup` component tree (`AuthLayout`, `AuthForm`, `FormField`,
  `SubmitButton`), and the Catalog step's `sessionStorage` read for genuine hydration hazards
  (`typeof window` render branches, `Date.now()`/`Math.random()`, locale-dependent output, invalid
  HTML nesting, storage reads during initial render, server/client data drift). None found. The
  Catalog `sessionStorage` read in particular is intentionally deferred into a `useEffect` — both
  the server render and the very first client render produce `imported === null`, so first-paint
  markup matches exactly; the actual storage read only happens after hydration reconciles, which is
  the standard safe pattern for this exact situation.
- **No `suppressHydrationWarning` was added, and `RootLayout` was not modified.** Silencing an
  extension-injected mismatch is explicitly the wrong fix — it would also hide a real future
  mismatch in the same subtree.

### 15.6 What remains demo-only (unchanged from §13)

Connect (Shopify), Catalog (upload/parsing/mapping), Blueprint, Build, and Launch are still
Phase 1 demo functionality, now operating within a real, persisted project/auth context rather
than a global in-memory one. No real Shopify OAuth, no real catalog parsing, no AI mapping, no
real build queue — all explicitly deferred to Phase 2B and beyond (§14).

### 15.7 Freeze statement

Phase 2A is frozen as of this checkpoint. Cloud schema deployed and verified; 8/8 RLS policies
confirmed on cloud; 24/24 RLS security assertions passed on cloud; real-browser signup, login,
persistence-on-refresh, and persistence-across-logout/login all manually confirmed; quality gate
(check:css/lint/typecheck/build) green; no secrets staged; hydration warning triaged and correctly
left unsuppressed. Ready for Phase 2B (real Shopify OAuth) to begin as a new, separate piece of work.

---

*Phase 2A complete and checkpointed. Shopify integration was not started.*
