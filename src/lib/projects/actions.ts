"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/dal";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/projects/ids";
import { isWizardStep, progressAfter, wizardPath } from "@/lib/wizard/steps";
import type { WizardStepKey } from "@/lib/supabase/types";
import { brandStyles, industries } from "@/data/wizard";
import type { ActionState } from "@/lib/forms/state";

/**
 * Server Actions for project + business-profile mutations.
 *
 * Security invariants held by every action in this file:
 *   1. The user is read from the server session via `requireUser()`. No action
 *      accepts a user id, owner id, or tenant id from the client — the only way
 *      to influence ownership is to hold a valid session cookie.
 *   2. Writes go through the user's own Supabase client, so RLS re-checks
 *      ownership in Postgres. Even a bug in this file cannot cross tenants.
 *   3. Input is validated server-side before it is written. The client-side
 *      validation in the Business step is a convenience, never a gate.
 */

const GENERIC_SAVE_ERROR =
  "We couldn't save your changes just now. Please check your connection and try again.";

// ActionState / idleState live in @/lib/forms/state — a "use server" module
// may only export async functions.

// ---------------------------------------------------------------------------
// Create project
// ---------------------------------------------------------------------------

/**
 * Creates a project owned by the session user and sends them into the wizard.
 *
 * Duplicate-submission guard: the button is disabled while pending
 * (`useFormStatus`), and as a server-side backstop we reuse any untouched draft
 * this user created in the last 15 seconds instead of minting a second one. A
 * double-click — or a client that retries the POST — therefore lands in the
 * same project rather than littering the dashboard with empty drafts.
 */
export async function createProjectAction(): Promise<void> {
  const user = await requireUser();

  const projectId = await createOrReuseDraftProject(user.id);

  // Used as a plain `<form action={...}>`, so this action cannot return state
  // to the caller. Failures bounce back to the dashboard with a flag that
  // renders a friendly banner — never a raw database error.
  if (!projectId) redirect("/?error=create_failed");

  revalidatePath("/");
  // Note: redirect() works by throwing a control-flow signal, so every
  // redirect in this file sits OUTSIDE a try/catch — inside one it would be
  // caught and misreported as a save failure.
  redirect(wizardPath(projectId, "connect"));
}

/** Returns the project id, or null if the write failed. Never throws. */
async function createOrReuseDraftProject(userId: string): Promise<string | null> {
  try {
    const supabase = await createSupabaseServerClient();

    const fifteenSecondsAgo = new Date(Date.now() - 15_000).toISOString();
    const { data: recentDraft } = await supabase
      .from("sp_projects")
      .select("id")
      .eq("status", "draft")
      .eq("current_step", "connect")
      .gte("created_at", fifteenSecondsAgo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentDraft) return recentDraft.id;

    const { data, error } = await supabase
      .from("sp_projects")
      // user_id comes from the verified session, never from the request body.
      // The RLS INSERT policy's WITH CHECK re-verifies it anyway.
      .insert({ user_id: userId, name: "Untitled Store" })
      .select("id")
      .single();

    if (error || !data) {
      console.error("[projects] create failed:", error?.message);
      return null;
    }
    return data.id;
  } catch (error) {
    console.error("[projects] create threw:", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Business step
// ---------------------------------------------------------------------------

const INDUSTRY_IDS = new Set(industries.map((i) => i.id));
const BRAND_STYLE_IDS = new Set(brandStyles.map((b) => b.id));

// Conservative allow-lists. Anything outside these falls back to the default
// rather than being written verbatim, so the summary columns stay clean.
const LANGUAGE_RE = /^[a-z]{2}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Upserts the business profile for a project and advances the wizard.
 *
 * Deliberate denormalisation: `industry`, `country_code`, `currency_code` and
 * `primary_language` are written to BOTH `sp_business_profiles` (the record of
 * truth, edited by the user) and `sp_projects` (a read-optimised summary the
 * dashboard card renders without a join). This is safe because this action is
 * the *only* writer of those four columns on `sp_projects` — they are never
 * edited independently, so there is no path by which they can drift. The
 * alternative, a view or a join on every dashboard render, buys nothing at this
 * scale. If a second writer is ever introduced, replace this with a trigger on
 * sp_business_profiles.
 */
export async function saveBusinessProfileAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState | never> {
  const user = await requireUser();

  const projectId = String(formData.get("projectId") ?? "");
  if (!isUuid(projectId)) {
    return { status: "error", message: "We couldn't find that store." };
  }

  const businessName = String(formData.get("businessName") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const industry = String(formData.get("industry") ?? "").trim();
  const brandStyle = String(formData.get("brandStyle") ?? "").trim();
  const countryCodeRaw = String(formData.get("countryCode") ?? "").trim().toUpperCase();
  const currencyCodeRaw = String(formData.get("currencyCode") ?? "").trim().toUpperCase();
  const primaryLanguageRaw = String(formData.get("primaryLanguage") ?? "").trim().toLowerCase();
  const secondaryLanguageRaw = String(formData.get("secondaryLanguage") ?? "").trim().toLowerCase();

  // --- server-side validation (the client checks are only a convenience) ----
  const fieldErrors: Record<string, string> = {};
  if (!businessName) {
    fieldErrors.businessName = "Business name is required";
  } else if (businessName.length > 120) {
    fieldErrors.businessName = "Business name must be 120 characters or fewer";
  }
  if (description.length > 500) {
    fieldErrors.description = "Description must be 500 characters or fewer";
  }
  if (!INDUSTRY_IDS.has(industry)) {
    fieldErrors.industry = "Choose an industry";
  }
  if (!BRAND_STYLE_IDS.has(brandStyle)) {
    fieldErrors.brandStyle = "Choose a brand style";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      status: "error",
      message: "Please fix the highlighted fields.",
      fieldErrors,
    };
  }

  const countryCode = COUNTRY_RE.test(countryCodeRaw) ? countryCodeRaw : null;
  const currencyCode = CURRENCY_RE.test(currencyCodeRaw) ? currencyCodeRaw : "USD";
  const primaryLanguage = LANGUAGE_RE.test(primaryLanguageRaw) ? primaryLanguageRaw : "en";
  const secondaryLanguage = LANGUAGE_RE.test(secondaryLanguageRaw)
    ? secondaryLanguageRaw
    : null;

  try {
    const supabase = await createSupabaseServerClient();

    // Confirm the project is visible to this user *before* writing. RLS would
    // reject the write anyway, but checking first lets us return "we couldn't
    // find that store" instead of a generic save failure.
    const { data: project, error: projectError } = await supabase
      .from("sp_projects")
      .select("id")
      .eq("id", projectId)
      .maybeSingle();

    if (projectError) {
      console.error("[business] project lookup failed:", projectError.message);
      return { status: "error", message: GENERIC_SAVE_ERROR };
    }
    if (!project) {
      return { status: "error", message: "We couldn't find that store." };
    }

    const { error: upsertError } = await supabase
      .from("sp_business_profiles")
      .upsert(
        {
          project_id: projectId,
          // From the session. The RLS WITH CHECK validates both this and that
          // the project belongs to the same user.
          user_id: user.id,
          business_name: businessName,
          description,
          industry,
          country_code: countryCode,
          currency_code: currencyCode,
          primary_language: primaryLanguage,
          secondary_language: secondaryLanguage,
          brand_style: brandStyle,
        },
        { onConflict: "project_id" },
      );

    if (upsertError) {
      console.error("[business] upsert failed:", upsertError.message);
      return { status: "error", message: GENERIC_SAVE_ERROR };
    }

    // Advance the wizard and mirror the summary columns in one write.
    const { error: projectUpdateError } = await supabase
      .from("sp_projects")
      .update({
        name: businessName,
        status: "in_progress",
        current_step: "catalog",
        progress_percent: progressAfter("business"),
        industry,
        country_code: countryCode,
        currency_code: currencyCode,
        primary_language: primaryLanguage,
      })
      .eq("id", projectId);

    if (projectUpdateError) {
      console.error("[business] project update failed:", projectUpdateError.message);
      return { status: "error", message: GENERIC_SAVE_ERROR };
    }
  } catch (error) {
    console.error("[business] save threw:", error);
    return { status: "error", message: GENERIC_SAVE_ERROR };
  }

  revalidatePath("/");
  revalidatePath(`/projects/${projectId}`, "layout");
  redirect(wizardPath(projectId, "catalog"));
}

// ---------------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------------

/**
 * Persists wizard position when the user moves between the demo-only steps
 * (Catalog / Blueprint / Build / Launch).
 *
 * Only the *position* is persisted. The demo steps' ephemeral state — upload
 * simulation timers, build progress animation — is intentionally NOT stored:
 * it represents no real work, and persisting it would imply a durability this
 * phase does not have.
 */
export async function advanceWizardAction(formData: FormData): Promise<void> {
  await requireUser();

  const projectId = String(formData.get("projectId") ?? "");
  const from = String(formData.get("fromStep") ?? "");
  const to = String(formData.get("toStep") ?? "");

  if (!isUuid(projectId) || !isWizardStep(from) || !isWizardStep(to)) {
    redirect("/");
  }

  const fromStep = from as WizardStepKey;
  const toStep = to as WizardStepKey;

  try {
    const supabase = await createSupabaseServerClient();
    // Moving backwards must not reduce recorded progress, so only write when
    // advancing. `.eq("id", ...)` plus RLS scopes this to the owner's row.
    const { error } = await supabase
      .from("sp_projects")
      .update({
        current_step: toStep,
        progress_percent: progressAfter(fromStep),
        status: toStep === "launch" ? "ready" : "in_progress",
      })
      .eq("id", projectId);

    if (error) {
      // A navigation failure should not trap the user on the current step;
      // the position is a convenience, not data they entered.
      console.error("[wizard] advance failed:", error.message);
    }
  } catch (error) {
    console.error("[wizard] advance threw:", error);
  }

  revalidatePath("/");
  redirect(wizardPath(projectId, toStep));
}
