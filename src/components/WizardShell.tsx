import type { ReactNode } from "react";
import { WizardProgress } from "@/components/WizardProgress";
import { wizardSteps } from "@/lib/wizard/steps";
import type { WizardStepKey } from "@/lib/supabase/types";

/**
 * Wizard chrome. Visually unchanged from Phase 1; it now takes the project id
 * so the step rail can deep-link within the project
 * (`/projects/[projectId]/wizard/[step]`), and `furthestStep` so it can show
 * which steps the merchant has actually reached.
 */
export function WizardShell({
  projectId,
  currentStep,
  furthestStep,
  title,
  description,
  children,
}: {
  projectId: string;
  currentStep: WizardStepKey;
  furthestStep: WizardStepKey;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="sp-animate-in flex flex-col gap-8 md:flex-row">
      <WizardProgress
        steps={wizardSteps}
        projectId={projectId}
        currentStep={currentStep}
        furthestStep={furthestStep}
      />
      <div className="min-w-0 flex-1">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-[var(--sp-muted)]">{description}</p>
        </div>
        <div className="rounded-2xl border border-[var(--sp-border)] bg-[var(--sp-surface)] p-5 shadow-sm sm:p-7">
          {children}
        </div>
      </div>
    </div>
  );
}
