# StorePilot — Phase 1 Foundation Report

## Baseline
- Repo: `D:\Projects\NextJS\storepilot` (git root is `D:\` drive-wide; this task made no git commits/pushes).
- Branch at start: `master`.
- Working tree at start: fresh `create-next-app` scaffold (default `src/app` with default `page.tsx`, `layout.tsx`, `globals.css`) plus `AGENTS.md`/`CLAUDE.md`.
- Stack: Next.js 16.3.5 (App Router, Turbopack), React 19.2.8, TypeScript 5, Tailwind CSS v4.
- Next.js 16 note applied: `params` in dynamic route pages is now a `Promise` and must be `await`ed — used in `src/app/wizard/[step]/page.tsx`.

## Architecture
Layered per spec: UI (`src/components`, `src/app`) → typed demo data (`src/data`) → thin service/integration boundaries (`src/lib/*`, types + stub async functions only, no real network/DB calls):
- `src/lib/shopify` — `connectDemoStore()` stub, `ShopifyConnection` type. No OAuth, no credentials.
- `src/lib/catalog` — `analyzeDemoUpload()` stub returning demo catalog data.
- `src/lib/blueprint` — `generateDemoBlueprint()` stub.
- `src/lib/build` — `pollBuildStatus()` stub (unused in Phase 1; UI uses a client-side `setInterval` timer instead, but the module documents the shape a real polling client would use).
- `src/lib/supabase` — `getProject()` stub, returns `null`. No persistence.

Wizard-wide state (business info, industry, brand style, connect/upload status) is held in a React Context (`src/app/wizard/WizardContext.tsx`) provided by `src/app/wizard/layout.tsx`, so it survives client-side navigation between `/wizard/[step]` routes without any backend.

## Files added/changed
**Data (typed mock/demo data)**
- `src/data/projects.ts` — demo projects (Royal Oud 94%/842 products, ABC Fashion 46%, North & Home draft) + dashboard metrics.
- `src/data/wizard.ts` — industries (10), brand styles (4), catalog mapping rows (7), catalog summary (842/18/7), blueprint collections/nav/pages, build resources, launch readiness buckets (auto/review/action).

**Integration boundary stubs**
- `src/lib/shopify/index.ts`, `src/lib/catalog/index.ts`, `src/lib/blueprint/index.ts`, `src/lib/build/index.ts`, `src/lib/supabase/index.ts`.

**Reusable components** (`src/components/`)
- `AppShell.tsx`, `WizardShell.tsx`, `WizardProgress.tsx`, `GradientButton.tsx`, `StatusBadge.tsx`, `MetricCard.tsx`, `ProjectCard.tsx`, `UploadDropzone.tsx`, `MappingRow.tsx`, `BlueprintPreview.tsx`, `BuildProgress.tsx`, `ActivityFeed.tsx`, `ReadinessScore.tsx`, `LaunchCheck.tsx`.

**App routes**
- `src/app/page.tsx` — Dashboard (rewritten).
- `src/app/layout.tsx` — updated metadata + body classes (edited).
- `src/app/globals.css` — premium emerald/green/mint gradient design system, dark mode, reduced-motion support (rewritten).
- `src/app/wizard/steps.ts` — step config/order/navigation helpers.
- `src/app/wizard/WizardContext.tsx` — client Context provider for wizard-wide state.
- `src/app/wizard/layout.tsx` — wraps wizard routes in `AppShell` + `WizardProvider`.
- `src/app/wizard/page.tsx` — redirects `/wizard` → `/wizard/connect`.
- `src/app/wizard/[step]/page.tsx` — server component; validates step via `generateStaticParams`/`notFound()`, awaits `params` (Next 16 async params).
- `src/app/wizard/WizardStepView.tsx` — client component rendering all 6 step UIs (Connect, Business, Catalog, Blueprint, Build, Launch) and step navigation.

## Screens implemented
1. **Dashboard (`/`)** — MetricCards, ProjectCards with gradient readiness bars, StatusBadge, "New Store" CTA, empty-state branch (unused today since demo data is non-empty, but implemented and reachable by clearing `demoProjects`).
2. **Wizard (`/wizard/[step]`, 6 steps)**:
   - **Connect** — no email/password fields; explicit "coming soon" real-OAuth disclaimer; "Connect Demo Store" button simulates a connection via `connectDemoStore()`.
   - **Business** — 10-industry visual picker, 4 brand styles, name/description inputs, inline required-field validation (errors shown only after first "Continue" attempt).
   - **Catalog** — `UploadDropzone` cycles empty → uploading → analyzing → warning (demo timer), then reveals 7 `MappingRow`s and StatusBadges for 842 products / 18 categories / 7 issues.
   - **Blueprint** — collections/nav/pages lists with concrete demo items, `BlueprintPreview` mock storefront panel (not a real iframe).
   - **Build** — `BuildProgress` per-resource counters (Products/Collections/Pages/Navigation/Theme) + `ActivityFeed` log lines, driven by `useEffect`/`setInterval`, architected so a real `pollBuildStatus()` call could replace the timer later.
   - **Launch** — `ReadinessScore` (87%), AUTO/REVIEW/ACTION `LaunchCheck` buckets with concrete items, "Preview Store"/"Open Shopify" buttons rendered `disabled` with `title` explaining they're demo-only.

## Responsive behavior
- `WizardProgress` renders a left rail (`hidden md:block`) on desktop/tablet and a compact top progress bar (`md:hidden`) with a `role="progressbar"` fill on mobile — not a shrunk desktop layout.
- Grids (`MetricCard`, `ProjectCard`, industry picker, mapping rows, launch buckets) collapse from multi-column to single/2-column via Tailwind breakpoints; no fixed widths that could overflow.
- Buttons/CTAs use `rounded-full` tap-friendly padding throughout.
- Verified no fixed-width elements likely to force horizontal scroll on narrow viewports (all containers use `max-w-*`/`w-full`/`flex-wrap`/`grid`).

## Accessibility
- Semantic elements: `header`/`nav`/`main`/`footer`, `fieldset`/`legend` for industry & style pickers, `label htmlFor` paired with inputs.
- Visible focus states via global `:focus-visible` outline in `globals.css`.
- Keyboard operability: `UploadDropzone` is a `role="button"` with `tabIndex={0}` and Enter/Space handling; all interactive controls are native `button`/`input`/`Link`.
- Status is never color-only: `StatusBadge` and `LaunchCheck` pair an icon glyph + text label with color; progress bars have `role="progressbar"` with `aria-valuenow/min/max`.
- `aria-invalid`/`aria-describedby` on Business step inputs when validation fails; `aria-pressed` on toggle-style picker buttons.
- `prefers-reduced-motion` media query in `globals.css` disables animations/transitions globally.

## Dependencies added
None. No new npm packages were installed — implementation uses existing Next/React/Tailwind only (no Framer Motion; CSS transitions/`@keyframes` used instead, satisfying the "plain CSS transitions are acceptable" allowance).

## Exact commands run and results
1. `npm run lint` → `> storepilot@0.1.0 lint\n> eslint` — **no errors/warnings output** (clean).
2. `npx tsc --noEmit` → **no output** (clean, exit 0).
3. `npm run build` → **Compiled successfully in 1488ms**, TypeScript check finished in 3.0s, static generation succeeded (11/11 pages). Route summary:
   - `○ /` (static)
   - `○ /_not-found` (static)
   - `○ /wizard` (static, redirect)
   - `● /wizard/[step]` (SSG via `generateStaticParams`): `connect`, `business`, `catalog`, `blueprint`, `build`, `launch`
4. Runtime sanity check: build output shows all routes prerendered without errors; no server/client component boundary violations reported by the Next.js build.
5. `grep -i 'type="email"|type="password"'` across `src/` → only match is the word "email"/"password" inside the disclaimer copy in `WizardStepView.tsx` ("StorePilot never asks for your Shopify email or password"); **no actual input fields of type email/password exist**.
6. `grep -i` for phrases like "connected to Shopify"/"live Shopify" → only match is the footer copy "No live Shopify connection." (a disclaimer, not a claim of integration). No copy anywhere claims a working/real Shopify integration; Connect step explicitly states real OAuth is "coming soon."

## Known limitations / explicitly mocked or demo functionality
- All data (projects, catalog stats, mappings, blueprint content, build resources, readiness buckets) is static/typed demo data in `src/data/*.ts` — nothing is fetched from a real backend.
- "Connect Demo Store" only sets local React state via a stub async function; no OAuth, no network call, no credentials collected or stored.
- Catalog upload accepts a file via a hidden `<input type="file">` for realism, but the file's contents are never read/parsed — the dropzone state machine is driven entirely by `setTimeout`s and always resolves to demo mapping data regardless of the file chosen.
- Build progress is a `setInterval`-driven simulation, not a real job queue; `src/lib/build`'s `pollBuildStatus` stub is defined but unused, documenting the future integration point.
- "Preview Store" and "Open Shopify" buttons on Launch are permanently `disabled` with explanatory `title` text — they perform no action.
- Wizard state resets on full page reload (in-memory React Context only, no persistence) — acceptable for Phase 1 demo scope.

## Deferred to Phase 2
Supabase persistence; real Shopify OAuth/Admin API integration; production CSV/XLSX parsing; AI-assisted field mapping; billing/subscriptions; payments; custom domains; agency/multi-client mode; production job queue/polling for builds; real store preview/publish flows.

## Phase 1B — Premium Visual Transformation

### Visual problems corrected
- **Critical CTA-visibility bug (root cause found and fixed).** Every primary button used a Tailwind arbitrary background value referencing a CSS custom property that resolved to a `linear-gradient(...)`. Tailwind v4 cannot statically infer that an opaque custom-property reference is a background-*image*, so it silently emitted a `background-color` declaration referencing that variable (or dropped the rule entirely) instead of a gradient — leaving white button text on a transparent/white background. This is exactly the "blank glowing pill" bug described in the brief, verified by screenshot before any fix (`GradientButton`, header "New/+New Store", "Connect Shopify" all rendered invisible in light mode). Fixed by replacing every such arbitrary value with real CSS utility classes defined in `globals.css` (`.sp-gradient-primary`, `.sp-gradient-soft`, `.sp-gradient-dark`, and a dedicated `.sp-btn-primary` for CTAs with explicit hover/active/disabled states). A second, related build-breaking issue was found during the fix: a code comment containing a literal arbitrary-value-shaped token naming that same background pattern was picked up by Tailwind's content scanner and generated invalid CSS ("Parsing CSS source code failed"), crashing the dev/build compiler — the comment wording was changed to avoid forming a scannable utility-class-like token. (Note: this documentation paragraph itself previously repeated that literal token for illustration, which reintroduced the same scanner crash — see Phase 1B.1 below.)
- Removed emoji industry icons; replaced with a small inline-SVG icon set (`src/components/IndustryIcon.tsx`), no icon library dependency added.
- Replaced the plain text "StorePilot" header with an original geometric brand mark (`src/components/BrandMark.tsx` — stacked ascending bars + spark, inline SVG) plus a wordmark, product nav (Dashboard/Wizard), and an avatar placeholder.
- Dashboard rebuilt with a premium dark-gradient hero (`sp-gradient-dark` + radial mint glow orb + abstract floating panel shapes), "Welcome back" / "Launch your next store in minutes." copy, metrics demoted below the hero, and richer `ProjectCard`s (gradient initials badge, near-ready green-border highlight ≥90%).
- Connect screen rebuilt around an original StorePilot-node ↔ store-node connection graphic with an animated dashed link and pulsing/traveling dot, "Connect Shopify →" CTA, and copy per the brief ("Connect your store and let StorePilot prepare the foundation...", with a smaller factual OAuth-not-implemented note).
- Business screen: industry cards use the new SVG icons with a stronger selected state (green border + soft glow ring); brand style cards get typography cues per style (serif/tracked for Luxury, bold for Modern, light/tight for Minimal, semibold for Playful); text inputs gained visible focus rings.
- Catalog screen: upload zone copy updated ("Upload your product catalog" / "CSV · XLSX · XLS"), animated glow border on the empty state, and a new results panel with large 842/18/7 stat tiles plus a staggered field-mapping reveal ("StorePilot understood your spreadsheet.").
- Blueprint preview rewritten as a miniature storefront inside browser chrome: wordmark, nav row, hero ("Discover timeless fragrance" / "Shop Collection"), New Arrivals grid, and collection chips — with distinct Luxury/Modern/Minimal/Playful visual presets (font, hero background, corner radius, accent color).
- Build screen: personalized headline ("We're building {business name}"), "In production, builds will continue safely in the background" subheading, and an automation-feed-style activity log (✓-prefixed friendly lines, deduped so the same line is never pushed twice in a row, active line pulses).
- Launch screen: readiness ring now animates 0 → 87% on mount (respects `prefers-reduced-motion`), headline changed to "Your store is almost ready to launch.", readiness buckets relabeled to match the brief (842 Products / 18 Collections / Navigation / Pages, Product descriptions / Refund policy, Connect payment provider / Configure domain / Run a test order), and the disabled Preview/Open Shopify buttons now render visibly muted (opacity + grayscale) instead of looking like normal enabled buttons.
- Wizard rail: each step now shows a short descriptor under its label, completed steps show a "pop" animated check, current step has a glowing ring, and an overall-progress bar was added under the step list.

### Files changed
`src/app/globals.css`, `src/app/page.tsx`, `src/app/wizard/steps.ts`, `src/app/wizard/WizardStepView.tsx`, `src/data/wizard.ts` (industry `emoji` → `icon` field, readiness bucket copy), `src/components/GradientButton.tsx`, `src/components/AppShell.tsx`, `src/components/ProjectCard.tsx`, `src/components/WizardProgress.tsx`, `src/components/BlueprintPreview.tsx`, `src/components/ReadinessScore.tsx`, `src/components/ActivityFeed.tsx`, `src/components/UploadDropzone.tsx`. New files: `src/components/BrandMark.tsx`, `src/components/IndustryIcon.tsx`.

### Design-system changes
`globals.css` now defines the gradients as real CSS custom properties **and** as `.sp-gradient-*` utility classes (the fix for the CTA bug), plus `.sp-btn-primary` (guaranteed-visible CTA with hover/active/disabled states), `.sp-card-hover`, `.sp-glow-orb`, `.sp-pulse`, `.sp-dash-animate`, `.sp-check-pop`, and `.sp-upload-glow`, all wrapped or skipped under `prefers-reduced-motion: reduce`. Palette adjusted to the brief's directional values (`#052e24`/`#047857`/`#10b981`/`#a7f3d0`) while keeping dark-mode variables from Phase 1A; `--sp-gradient-soft` now has a dark-mode override so light-tinted panels don't turn into blinding white cards in dark mode (a regression caught during this pass's own screenshot QA and fixed before hand-off).

### Responsive QA
Verified 1440px and 390px widths via Playwright screenshots (dashboard, connect, business, catalog, blueprint, build, launch). No horizontal overflow observed; wizard rail collapses to the existing compact top progress bar under `md`; hero, metrics, and project cards stack correctly on mobile. 1280/1024/768 were not separately screenshotted (time-boxed); layouts use the same `sm`/`md`/`lg` Tailwind breakpoints already exercised at 1440/390, so intermediate widths are expected to interpolate correctly, but this is inferred rather than directly captured.

### Dark-mode QA
Directly screenshotted (not just inferred): Dashboard and Connect in dark mode both read cleanly with visible CTA text, correct gradient rendering, and legible borders/muted text. Found and fixed one real dark-mode regression during this pass: the Connect screen's node-link panel used a light-only gradient that stayed bright white in dark mode, making dark-on-white text/icons unreadable — resolved by giving `--sp-gradient-soft` a dark-mode variant instead of overriding the class per-usage.

### Accessibility QA
Focus-visible outline preserved globally; text inputs gained explicit focus rings; all icon-only elements (brand mark, industry icons, status glyphs, connection graphic) are `aria-hidden`; disabled Preview/Open Shopify buttons keep descriptive `title` attributes and are now visually distinct (opacity + grayscale) from enabled buttons, not just `disabled:opacity-60` on a still-vivid gradient; build activity feed and progress bar retain `aria-live`/`role="progressbar"` from Phase 1A. Not independently re-audited with an automated a11y scanner (e.g. axe) in this pass — done via code review + visual check only.

### Lint / typecheck / build results
- `npm run lint` — **pass**, 0 errors/warnings (one real error found and fixed: a `react-hooks/set-state-in-effect` violation in the new `ReadinessScore` count-up animation, resolved by wrapping the reduced-motion branch in `requestAnimationFrame`).
- `npx tsc --noEmit` — **pass**, no errors.
- `npm run build` — **pass**. One CSS parser warning/build-breaking error was hit and fixed mid-pass (see CTA bug note above — a code comment, not app code, was the cause); the final build is clean with no warnings.

### Verification method
Screenshots were actually captured and visually inspected (not inferred from code) using Playwright, driving the project's own `next dev` server at `localhost:3001`, at 1440px and 390px widths, in both `light` and `dark` `colorScheme` contexts, across Dashboard, Connect, Business, Catalog, Blueprint, Build, and Launch. This is how the CTA bug's root cause was confirmed and how the dark-mode Connect regression was caught and fixed before hand-off.

## Phase 1B.1 — CSS Regression Repair

### Root cause
After the Phase 1B fix, `npm run build`/`next dev` (Turbopack) started failing with an invalid-CSS parser error referencing `src/app/globals.css` and an "Unexpected token" pointing at a malformed `background-color` declaration. No application source under `src/` ever contained the malformed pattern — the true root cause was that Tailwind v4's *automatic content detection* (the default behavior when `globals.css` only declares `@import "tailwindcss";` with no explicit source configuration) scans the entire project directory, respecting `.gitignore`, and treats every text file — including this Markdown report — as scannable source. It pattern-matches candidate utility-class-shaped strings without understanding Markdown code spans or code fences. An earlier revision of this same report illustrated the original bug using the exact bracketed arbitrary-value string as a quoted example; Tailwind's scanner read that illustrative example as a real candidate class and tried to generate a CSS rule for it, reproducing the identical crash from documentation alone, with zero application code involved.

### Offending file / line
The single offending source was this report file itself (Phase 1B and, once repeated for explanation, Phase 1B.1), which contained the illustrative bracketed arbitrary-value string as literal text rather than an escaped/described pattern.

### Why the previous (1B.1) repair was only temporary
Phase 1B.1 removed that literal string from the report but did not change how Tailwind scans the project. Because scanning was still unrestricted, explaining the fix in this same document required referencing the pattern again for clarity — which reintroduced it and broke the build a second time. Deleting individual tokens can never be a permanent fix while documentation remains inside Tailwind's scan boundary; the boundary itself had to change.

### Permanent fix
`globals.css` now disables Tailwind's automatic project-wide content detection and explicitly scopes candidate scanning to the application source tree only (see "Source-scanning configuration" below). Documentation, README files, logs, and any other non-application text can no longer influence generated CSS, regardless of what illustrative code strings they contain. No application source files required changes — the Phase 1B fix's `.sp-gradient-primary` / `.sp-gradient-dark` / `.sp-gradient-soft` / `.sp-btn-primary` CSS classes were untouched and remain in place; no arbitrary CSS-variable gradient background was reintroduced.

### Source-scanning configuration
- **Installed Tailwind version:** `tailwindcss@4.3.3` (via `@tailwindcss/postcss`).
- **Before:** `src/app/globals.css` began with a bare `@import "tailwindcss";`, which enables Tailwind v4's default automatic content detection across the whole project (minus `.gitignore`d paths) — no boundary existed between application code and documentation/reports.
- **After:** `src/app/globals.css` now begins with `@import "tailwindcss" source(none);` (disables automatic detection for this import) followed by an explicit `@source` directive scoped to `../**/*` with application-code extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.mdx`) relative to `src/app`, i.e. the `src/` tree only. `docs/`, `README.md`, logs, and `.next/` are outside this boundary and are never scanned.

### Clean-build verification
- Removed `.next` entirely (`rm -rf` failed on a locked Turbopack cache subfolder on Windows; re-run via `Remove-Item -Recurse -Force` in PowerShell succeeded) before re-running the gate, so results below are against freshly generated CSS/build output.
- `npm run lint` — **pass**, exit 0, no errors/warnings.
- `npx tsc --noEmit` — **pass**, no output/errors.
- `npm run build` — **pass**. Turbopack compiled successfully in ~12.4s, TypeScript check finished clean, all 11 routes (`/`, `/_not-found`, `/wizard`, `/wizard/[step]` × 6 static params) generated successfully. No CSS parsing error, no warnings.

### Runtime verification
Started a fresh `next dev` server (after freeing port 3000, which had a stale listener from an earlier session) and requested the pages directly:
- `GET /` → `200`, HTML contains `sp-btn-primary` / `sp-gradient-primary` classes rendering as expected, no "Parsing CSS", "Unexpected token", or server-error text anywhere in the response.
- `GET /wizard/connect` → `200`, same clean result, dev server log shows no compiler errors.
- Dev server log for the full session shows only successful `GET ... 200` lines — no `⨯` compiler errors at any point after the fix.

### Search confirmation
Re-ran the search for `var\(\.\.\.` and for `bg-\[var\(\.\.\.\)\]` / `bg-\[var\(--sp-gradient` across the entire project (excluding `node_modules`) after the fix: **zero matches**, confirming the offending token is fully removed.

## Phase 1B.2 — Permanent Tailwind Source-Scanning Fix

The 1B.1 repair (deleting the offending text from the report) was correct but insufficient: the malformed pattern reappeared in this same report while explaining the earlier fix (see "Why the previous repair was only temporary" above), reproducing the identical build crash from documentation alone a second time. This confirmed the real defect was never a specific string — it was that Tailwind's scan boundary included non-application files at all. 1B.2 closes that boundary permanently instead of chasing individual tokens.

### Current offending source (found before this fix)
Re-confirmed via full-repo search (excluding `node_modules`) for `var\(\.\.\.`: the only match was again inside `docs/PHASE1_FOUNDATION_REPORT.md` — specifically the Phase 1B.1 section's own explanation, which necessarily quoted the malformed pattern to describe it. No occurrence existed in `src/`, `README.md`, or anywhere else.

### Why the 1B.1 repair was only temporary
Documented above under "Why the previous (1B.1) repair was only temporary" — reproduced here for completeness: deleting a token does not remove the underlying scan boundary. As long as Tailwind auto-scans the entire project, any future text describing this bug (in this report, a code comment, a commit message rendered into a scanned file, etc.) risks recreating it.

### Installed Tailwind version
`tailwindcss@4.3.3`, via `@tailwindcss/postcss@4.3.3` (confirmed from `node_modules/tailwindcss/package.json`).

### Source-scanning configuration — before
`src/app/globals.css` line 1: `@import "tailwindcss";` — no `source()` modifier and no `@source`/`@source not` directives anywhere in the project. This enables Tailwind v4's default automatic content detection, which walks the entire project directory (respecting `.gitignore`) looking for candidate class strings in every file type, with no distinction between `src/` application code and `docs/`, `README.md`, or any other text.

### Source-scanning configuration — after
`src/app/globals.css` now reads:
```css
@import "tailwindcss" source(none);

@source "../**/*.{ts,tsx,js,jsx,mdx}";
```
`source(none)` on the `@import` disables Tailwind's automatic project-wide detection entirely. The explicit `@source` directive (documented Tailwind v4 syntax, confirmed against the installed `tailwindcss@4.3.3` compiler source, which parses `@source "<quoted-pattern>"` and `@source not "<quoted-pattern>"` at the top level of a stylesheet) then declares the *only* boundary Tailwind is allowed to scan: everything under `src/` (the pattern is `../**/*` relative to `src/app`, the directory containing `globals.css`) with application-code extensions. `docs/`, `README.md`, log files, and `.next/` fall outside this pattern and are structurally unreachable by the scanner — not merely "currently clean of bad tokens."

### Files changed
- `src/app/globals.css` — added `source(none)` to the Tailwind import and an explicit `@source` boundary, with an explanatory comment.
- `docs/PHASE1_FOUNDATION_REPORT.md` — reworded the Phase 1B.1 section to describe the malformed pattern without reproducing it literally, and added this Phase 1B.2 section (itself written to describe the fix without containing a literal instance of the malformed pattern — see the boundary test below for how this was actually verified rather than assumed).
- `scripts/check-css.mjs` (new) — regression guard script (see below).
- `package.json` — added `check:css` script entry.

### Cache cleanup confirmation
Stopped all listening dev-server processes on ports 3000–3002 first (`Get-NetTCPConnection` + `Stop-Process` in PowerShell), then removed `.next` with `Remove-Item -Recurse -Force` and confirmed via `Test-Path` returning `False` before any rebuild. This was repeated a second time later in the same pass (after the fresh-dev-server check) to prove the second production build was not reusing stale cache either.

### `npm run lint` result
Pass — exit 0, no errors/warnings, run against a fully clean `.next`.

### `npx tsc --noEmit` result
One transient, expected failure was hit and explained (not a regression): immediately after deleting `.next`, standalone `tsc --noEmit` failed with `Cannot find name 'LayoutProps'` in `src/app/layout.tsx`, because that global type is generated by Next.js into `.next/types/` and does not exist until Next has run at least once. Running `npx next typegen` (generates route types without a full build) regenerated it; `npx tsc --noEmit` then passed with no errors. This is a normal Next.js/TypeScript interaction, not a Tailwind or CSS issue, and does not affect `npm run build` (which runs its own internal TypeScript pass and always regenerates these types first).

### First clean build result
`npm run build` — pass. Compiled successfully, TypeScript pass clean, all 11 routes generated, no CSS parsing errors, no warnings.

### Fresh dev-server result
Started a brand-new `next dev` process (not a reused one) after the clean build. Requested both routes directly:
- `GET /` → `200`
- `GET /wizard/connect` → `200`
Dev server log showed only successful `GET ... 200` lines for the full session — no compiler (`⨯`) errors. Server was then stopped and the port confirmed free before proceeding.

### Second build result (after dev server)
`npm run build`, run again immediately after stopping the fresh dev server (no cache cleared in between, deliberately — to prove the dev server run itself cannot regenerate the invalid candidate and poison the next build) — pass. Compiled successfully, all 11 routes generated, no warnings.

### Regression guard result
Added `scripts/check-css.mjs` (plain Node.js `.mjs`, no dependency, cross-platform) and `npm run check:css`. It scans `src/` and `docs/` (plus `README.md`) for two patterns: (1) a literal ellipsis used as a fake CSS custom-property name inside a `var()` call, and (2) that same fake-name shape written as a Tailwind arbitrary-value background candidate — while explicitly *not* flagging legitimate CSS variable references with real property names, of which the codebase has many. It also inspects any generated `.next/static/chunks/*.css` for the equivalent malformed declaration, if a build has been run. Verified both ways: a temporary file reproducing that exact malformed shape was added under `docs/`, the script correctly failed with a precise file:line report, then passed again cleanly once the file was removed. The guard's own source and its error-message strings necessarily contain the literal pattern it detects (as string constants), so `scripts/*.mjs` is intentionally outside both the regression guard's own docs/README scan and Tailwind's `@source` boundary — its detection logic was proven correct via the temporary-file test, not by self-scanning.

### Docs exclusion / boundary test
Created a temporary file `docs/_boundary_test.md` (docs-only, never touching `src/`) containing a harmless, distinctive fake utility candidate name that does not use the malformed pattern at all, so it could not crash the parser regardless of outcome — it could only prove or disprove that `docs/` content gets scanned into CSS. Ran a full clean rebuild (`rm -rf .next && npm run build`) with that file present — build succeeded. Then searched the entire `.next/` build output for that distinctive string: zero matches. This confirms the `@source` boundary genuinely prevents `docs/` content from being scanned or generating CSS, not just that no build-breaking string happened to be present. The temporary file was deleted immediately afterward and `check:css` re-run clean.

### Git status
`git status --short .` inside the project directory returns `?? ./` — the entire `storepilot` directory is untracked in the drive-wide git repository rooted at `D:\`. No files were staged, committed, or pushed during this task, consistent with prior phases.
