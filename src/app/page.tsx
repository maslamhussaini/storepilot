import { AppShell } from "@/components/AppShell";
import { MetricCard } from "@/components/MetricCard";
import { ProjectCard } from "@/components/ProjectCard";
import { FormAlert } from "@/components/FormField";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth/dal";
import { listProjects } from "@/lib/projects/queries";
import { toProjectCardModel } from "@/lib/projects/view";
import { createProjectAction } from "@/lib/projects/actions";
import type { SpProject } from "@/lib/supabase/types";

/**
 * Dashboard — real data.
 *
 * Renders the signed-in user's own `sp_projects` rows, fetched server-side.
 * The Phase 1 mock array in `src/data/projects.ts` is NOT imported here; it is
 * retained in the repo purely as design reference and is explicitly marked as
 * such in that file.
 *
 * Route protection is layered: `src/proxy.ts` redirects unauthenticated
 * visitors before this renders, `requireUser()` below re-checks on the server,
 * and RLS scopes the query in Postgres. The page is dynamic (it reads cookies),
 * so no protected markup is ever prerendered or cached.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [user, { error }] = await Promise.all([requireUser(), searchParams]);
  const result = await listProjects();

  const projects = result.status === "ok" ? result.data : [];
  const schemaMissing = result.status === "schema_missing";
  const unavailable = result.status !== "ok" && !schemaMissing;

  return (
    <AppShell user={user}>
      <div className="sp-animate-in">
        <section className="relative overflow-hidden rounded-3xl border border-[var(--sp-border)] sp-gradient-dark px-6 py-10 text-white sm:px-10 sm:py-14">
          <div
            aria-hidden="true"
            className="sp-glow-orb pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full opacity-70"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-10 bottom-0 hidden h-56 w-72 sm:block"
          >
            {/* Abstract floating store / collection cards — original decorative graphic */}
            <div className="absolute right-4 top-2 h-24 w-32 -rotate-6 rounded-xl border border-white/15 bg-white/10 backdrop-blur-sm" />
            <div className="absolute right-24 top-16 h-20 w-28 rotate-3 rounded-xl border border-white/15 bg-white/10 backdrop-blur-sm" />
            <div className="absolute right-0 bottom-2 h-16 w-24 rotate-12 rounded-xl border border-[var(--sp-mint-300)]/40 bg-[var(--sp-mint-300)]/10 backdrop-blur-sm" />
          </div>

          <div className="relative max-w-xl">
            <p className="text-xs font-semibold uppercase tracking-widest text-[var(--sp-mint-300)]">
              Welcome back
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Launch your next store in minutes.
            </h1>
            <p className="mt-3 text-sm text-white/75 sm:text-base">
              Turn a product spreadsheet into a structured, launch-ready Shopify store.
            </p>
            <div className="mt-6">
              <form action={createProjectAction}>
                <SubmitButton pendingLabel="Creating…">+ Build New Store</SubmitButton>
              </form>
            </div>
          </div>
        </section>

        {error === "create_failed" ? (
          <div className="mt-6">
            <FormAlert tone="error">
              We couldn&apos;t create that store just now. Please try again in a moment.
            </FormAlert>
          </div>
        ) : null}

        {schemaMissing ? (
          <div className="mt-6">
            <FormAlert tone="error">
              StorePilot&apos;s database hasn&apos;t been set up in this environment yet
              (connected to Supabase, but the <code>sp_projects</code> table doesn&apos;t exist)
              — this is a deployment step, not an outage.
            </FormAlert>
          </div>
        ) : null}

        {unavailable ? (
          <div className="mt-6">
            <FormAlert tone="error">
              We&apos;re having trouble loading your stores right now. Your work is safe —
              please refresh in a moment.
            </FormAlert>
          </div>
        ) : null}

        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {buildMetrics(projects).map((metric) => (
            <MetricCard key={metric.label} metric={metric} />
          ))}
        </div>

        <div className="mt-10">
          <h2 className="text-lg font-semibold">Projects</h2>
          {projects.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-[var(--sp-border)] p-12 text-center">
              <p className="font-medium">No stores yet.</p>
              <p className="mt-1 text-sm text-[var(--sp-muted)]">
                Start your first store launch in a few guided steps.
              </p>
              <div className="mt-4 flex justify-center">
                <form action={createProjectAction}>
                  <SubmitButton pendingLabel="Creating…">
                    + Build Your First Store
                  </SubmitButton>
                </form>
              </div>
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={toProjectCardModel(project)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

/**
 * Metrics derived from the user's own rows. Phase 1 showed four hardcoded
 * figures; three of the four can be computed honestly from real data now. The
 * fourth (stores launched) is still structurally zero because launching is not
 * implemented, and says so rather than inventing a number.
 */
function buildMetrics(projects: SpProject[]) {
  const active = projects.filter((p) => p.status !== "archived").length;
  const ready = projects.filter((p) => p.status === "ready").length;
  const avgReadiness =
    projects.length === 0
      ? 0
      : Math.round(
          projects.reduce((sum, p) => sum + p.progress_percent, 0) / projects.length,
        );

  return [
    {
      label: "Active projects",
      value: String(active),
      helpText: active === 1 ? "One store in flight" : "Across all industries",
    },
    {
      label: "Ready for review",
      value: String(ready),
      helpText: "Wizard completed",
    },
    {
      label: "Avg. readiness score",
      value: `${avgReadiness}%`,
      helpText: projects.length === 0 ? "No projects yet" : "Across your projects",
    },
    {
      label: "Stores launched",
      value: "0",
      helpText: "Launch is not implemented in this phase",
    },
  ];
}
