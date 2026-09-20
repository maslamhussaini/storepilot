import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { WizardShell } from "@/components/WizardShell";
import { GradientButton } from "@/components/GradientButton";
import { FormAlert } from "@/components/FormField";
import { WizardStepView } from "@/app/projects/[projectId]/wizard/[step]/WizardStepView";
import { requireUser } from "@/lib/auth/dal";
import { getProjectWithProfile } from "@/lib/projects/queries";
import { getStep, isWizardStep } from "@/lib/wizard/steps";

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
  searchParams: Promise<{ shopify_spike?: string; shopify_error?: string; shop?: string }>;
}) {
  const [{ projectId, step }, user, sp] = await Promise.all([params, requireUser(), searchParams]);

  // Phase 2B.2b connectivity-spike result, surfaced to the Connect step only.
  // Non-sensitive by construction: the callback route only ever puts a
  // success flag + shop domain, or a generic error reason, into this query —
  // never a token value.
  const shopifyResult: { status: "ok"; shop: string } | { status: "error"; reason: string } | null =
    sp.shopify_spike === "ok"
      ? { status: "ok", shop: sp.shop ?? "" }
      : sp.shopify_error
        ? { status: "error", reason: sp.shopify_error }
        : null;

  if (!isWizardStep(step)) notFound();

  const result = await getProjectWithProfile(projectId);

  if (result.status === "unauthenticated") redirect("/login");

  if (result.status === "unavailable") {
    return (
      <AppShell user={user}>
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
      <AppShell user={user}>
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
      <AppShell user={user}>
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

  return (
    <AppShell user={user}>
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
          shopifyResult={shopifyResult}
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
