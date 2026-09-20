import { WIZARD_STEP_KEYS, type WizardStepKey } from "@/lib/supabase/types";

/**
 * Wizard step definitions.
 *
 * Moved here from `src/app/wizard/steps.ts` in Phase 2A: the wizard is now
 * addressed as `/projects/[projectId]/wizard/[step]`, and these constants are
 * shared by server actions and database validation, so they no longer belong
 * inside a route folder.
 *
 * The step ids are the single source of truth for the `current_step` CHECK
 * constraint on `sp_projects`. `WIZARD_STEP_KEYS` (in supabase/types.ts) mirrors
 * the constraint; the assertion below keeps the two from drifting apart.
 */

export interface WizardStep {
  id: WizardStepKey;
  label: string;
  title: string;
  description: string;
  /**
   * Progress persisted to `sp_projects.progress_percent` once this step has
   * been completed. Chosen so the six steps land on a clean 100 at Launch.
   */
  progressOnComplete: number;
}

export const wizardSteps: WizardStep[] = [
  {
    id: "connect",
    label: "Connect",
    title: "Connect your Shopify store",
    description: "Securely authorize StorePilot to prepare your storefront.",
    progressOnComplete: 16,
  },
  {
    id: "business",
    label: "Business",
    title: "Tell us about your business",
    description: "Pick your industry and brand style so we can tailor your blueprint.",
    progressOnComplete: 33,
  },
  {
    id: "catalog",
    label: "Catalog",
    title: "Import your catalog",
    description: "Upload a product spreadsheet and review the field mapping.",
    progressOnComplete: 50,
  },
  {
    id: "blueprint",
    label: "Blueprint",
    title: "Review your store blueprint",
    description: "Collections, navigation, and pages generated from your catalog.",
    progressOnComplete: 66,
  },
  {
    id: "build",
    label: "Build",
    title: "We're building your store",
    description: "Sit back while we assemble your storefront resources.",
    progressOnComplete: 83,
  },
  {
    id: "launch",
    label: "Launch",
    title: "Your store is almost ready to launch",
    description: "Review what's automated, what needs review, and what needs action.",
    progressOnComplete: 100,
  },
];

export const stepIds: WizardStepKey[] = wizardSteps.map((s) => s.id);

// Compile-time guard: the route step list and the database CHECK constraint
// list must contain the same keys in the same order.
const _stepKeysMatchDatabase: readonly WizardStepKey[] = WIZARD_STEP_KEYS;
void _stepKeysMatchDatabase;

export function isWizardStep(value: string): value is WizardStepKey {
  return (stepIds as string[]).includes(value);
}

export function getStep(id: WizardStepKey): WizardStep {
  return wizardSteps.find((s) => s.id === id)!;
}

export function stepIndex(id: string): number {
  return wizardSteps.findIndex((s) => s.id === id);
}

export function nextStepId(id: string): WizardStepKey | null {
  const idx = stepIndex(id);
  return idx >= 0 && idx < wizardSteps.length - 1 ? wizardSteps[idx + 1]!.id : null;
}

export function prevStepId(id: string): WizardStepKey | null {
  const idx = stepIndex(id);
  return idx > 0 ? wizardSteps[idx - 1]!.id : null;
}

/** Progress to persist once `id` has been completed and the user moves on. */
export function progressAfter(id: WizardStepKey): number {
  return getStep(id).progressOnComplete;
}

/** Canonical URL for a step of a given project. */
export function wizardPath(projectId: string, step: WizardStepKey): string {
  return `/projects/${projectId}/wizard/${step}`;
}
