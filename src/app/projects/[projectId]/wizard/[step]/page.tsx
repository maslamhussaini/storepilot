import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { WizardShell } from "@/components/WizardShell";
import { GradientButton } from "@/components/GradientButton";
import { FormAlert } from "@/components/FormField";
import { WizardStepView } from "@/app/projects/[projectId]/wizard/[step]/WizardStepView";
import { requireUser } from "@/lib/auth/dal";
import { getConnectionStatus } from "@/lib/shopify/connections";
import { getProjectWithProfile } from "@/lib/projects/queries";
import { getStep, isWizardStep } from "@/lib/wizard/steps";
import { NO_CONNECTION } from "@/lib/shopify/status";

export const metadata: Metadata = {
  title: "Store setup — StorePilot",
};

/**
 * The wizard, addressed by real project id.
 *
 * ROUTE CHOICE: `/projects/[projectId]/wizard/[step]`. The project id is the
 * tenancy root, so it belongs at the front of the path — every segment beneath
 * it is unambiguously scoped to one project, and adding future project-level
 * surfaces (`/projects/[id]/settings`) needs no restructuring. The Phase 1
 * global `/wizard/[step]` route is gone; it had nowhere to put ownership.
 *
 * DATA FLOW ON REFRESH: this is a Server Component that reads cookies, so every
 * navigation and every browser refresh re-runs it, re-reads the project and
 * business profile from Postgres under the user's own session, and hands the
 * result to the client view as props. Nothing durable lives in React state, so
 * a refresh restores the merchant exactly where they were.
 *
 * SECURITY: `requireUser()` re-verifies the session server-side (the proxy
 * redirect is only a UX nicety), and `getProjectWithProfile` returns null for
 * both "no such project" and "someone else's project" — a tampered projectId in
 * the URL therefore renders the same "we couldn't find that store" page as a
 * typo, leaking nothing (security scenario G).
 */
export default async function ProjectWizardStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; step: string }>;
  searchParams: Promise<{ shopify_oauth?: string; shopify_error?: string }>;
}) {
  const [{ projectId, step }, user, sp] = await Promise.all([params, requireUser(), searchParams]);

  // Phase 2B.3B-1: `shopify_oauth` is a NON-SENSITIVE flag meaning only "an
  // OAuth attempt came back". It is deliberately NOT a success signal for the
  // UI — connected status is read from durable Supabase metadata below, so a
  // hand-crafted query string can never fake a connection. `shopify_error`
  // carries a generic, non-sensitive reason code from the callback.
  const oauthError: string | null = sp.shopify_error ?? null;

  if (!isWizardStep(step)) notFound();

  const result = await getProjectWithProfile(projectId);

  if (result.status === "unauthenticated") redirect("/login");

  if (result.status === "unavailable") {
    return (
      <AppShell user={user} showNewStore={false}>
        <div className="sp-animate-in mx-auto max-w-xl py-12">
          <FormAlert tone="error">
            We&apos;re having trouble reaching StorePilot&apos;s servers. Nothing you&apos;ve
            saved has been lost — please try again in a moment.
          </FormAlert>
          <div className="mt-6">
            <GradientButton href="/" variant="secondary">
              ← Back to dashboard
            </GradientButton>
          </div>
        </div>
      </AppShell>
    );
  }

  if (result.status === "schema_missing") {
    return (
      <AppShell user={user} showNewStore={false}>
        <div className="sp-animate-in mx-auto max-w-xl py-12">
          <FormAlert tone="error">
            StorePilot&apos;s database hasn&apos;t been set up in this environment yet — the app
            reached Supabase, but the required tables don&apos;t exist. This is a deployment
            step, not a service outage.
          </FormAlert>
          <div className="mt-6">
            <GradientButton href="/" variant="secondary">
              ← Back to dashboard
            </GradientButton>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!result.data) {
    return (
      <AppShell user={user} showNewStore={false}>
        <div className="sp-animate-in mx-auto max-w-xl py-16 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            We couldn&apos;t find that store
          </h1>
          <p className="mt-2 text-sm text-[var(--sp-muted)]">
            It may have been deleted, or the link may be incorrect.
          </p>
          <div className="mt-6 flex justify-center">
            <GradientButton href="/">Back to dashboard</GradientButton>
          </div>
        </div>
      </AppShell>
    );
  }

  const { project, profile } = result.data;
  const meta = getStep(step);

  // DURABLE connection state — the single source of truth for "connected?"
  // on the Connect step. Read from sp_shopify_connections via the safe
  // get_connection_metadata RPC under the user's own session (RLS + ownership
  // checked inside the function). Survives refresh, new tabs, sign-out and
  // sign-in. `null` (error/schema-missing) fails closed to "not connected".
  const connection = await getConnectionStatus(project.id);

  return (
    <AppShell user={user} showNewStore={false}>
      <WizardShell
        projectId={project.id}
        currentStep={step}
        furthestStep={project.current_step}
        title={meta.title}
        description={meta.description}
      >
        <WizardStepView
          step={step}
          projectId={project.id}
          projectName={project.name}
          connection={connection ?? NO_CONNECTION}
          oauthError={oauthError}
          profile={
            profile
              ? {
                  businessName: profile.business_name,
                  description: profile.description,
                  industry: profile.industry,
                  brandStyle: profile.brand_style,
                  countryCode: profile.country_code,
                  currencyCode: profile.currency_code,
                  primaryLanguage: profile.primary_language,
                  secondaryLanguage: profile.secondary_language,
                }
              : null
          }
        />
      </WizardShell>
    </AppShell>
  );
}
