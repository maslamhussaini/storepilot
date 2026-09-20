import Link from "next/link";
import { stepIndex, wizardPath, type WizardStep } from "@/lib/wizard/steps";
import type { WizardStepKey } from "@/lib/supabase/types";

/**
 * Wizard step rail. Markup and classes are unchanged from Phase 1.
 *
 * Phase 2A additions:
 *   * links are project-scoped (`/projects/[id]/wizard/[step]`);
 *   * steps beyond the merchant's furthest *persisted* position render as
 *     non-interactive spans rather than links, so the rail can't be used to
 *     skip past a step whose data hasn't been saved yet;
 *   * the progress readout reflects the persisted position, not just the page
 *     currently on screen.
 */
export function WizardProgress({
  steps,
  projectId,
  currentStep,
  furthestStep,
}: {
  steps: WizardStep[];
  projectId: string;
  currentStep: WizardStepKey;
  furthestStep: WizardStepKey;
}) {
  const currentIndex = stepIndex(currentStep);
  const furthestIndex = Math.max(stepIndex(furthestStep), currentIndex);

  return (
    <>
      {/* Desktop left rail */}
      <nav aria-label="Wizard progress" className="hidden w-60 shrink-0 md:block">
        <ol className="space-y-1">
          {steps.map((step, index) => {
            const state =
              index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
            const reachable = index <= furthestIndex;

            const inner = (
              <>
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    state === "done"
                      ? "sp-gradient-primary sp-check-pop text-white"
                      : state === "current"
                        ? "border-2 border-[var(--sp-green-500)] text-[var(--sp-green-500)] shadow-[0_0_0_4px_rgba(16,185,129,0.15)]"
                        : "border border-[var(--sp-border)] text-[var(--sp-muted)]"
                  }`}
                >
                  {state === "done" ? "✓" : index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block">{step.label}</span>
                  <span className="block truncate text-xs font-normal opacity-70">
                    {shortDescriptors[step.id]}
                  </span>
                </span>
              </>
            );

            const className = `flex items-start gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${
              state === "current"
                ? "bg-[var(--sp-mint-100)] font-semibold text-[var(--sp-emerald-800)] dark:bg-white/10 dark:text-[var(--sp-mint-200)]"
                : reachable
                  ? "text-[var(--sp-muted)] hover:bg-black/[.03] dark:hover:bg-white/5"
                  : "text-[var(--sp-muted)] opacity-50"
            }`;

            return (
              <li key={step.id}>
                {reachable ? (
                  <Link
                    href={wizardPath(projectId, step.id)}
                    aria-current={state === "current" ? "step" : undefined}
                    className={className}
                  >
                    {inner}
                  </Link>
                ) : (
                  <span aria-disabled="true" className={className}>
                    {inner}
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        <div className="mt-4 px-3">
          <div className="flex items-center justify-between text-[11px] text-[var(--sp-muted)]">
            <span>Overall progress</span>
            <span>{Math.round(((currentIndex + 1) / steps.length) * 100)}%</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
            <div
              className="h-full rounded-full sp-gradient-primary transition-[width] duration-500"
              style={{ width: `${((currentIndex + 1) / steps.length) * 100}%` }}
            />
          </div>
        </div>
      </nav>

      {/* Mobile compact top bar */}
      <div className="mb-6 md:hidden">
        <div className="flex items-center justify-between text-xs text-[var(--sp-muted)]">
          <span>
            Step {currentIndex + 1} of {steps.length}
          </span>
          <span className="font-medium text-[var(--foreground)]">
            {steps[currentIndex]?.label}
          </span>
        </div>
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10"
          role="progressbar"
          aria-valuenow={currentIndex + 1}
          aria-valuemin={1}
          aria-valuemax={steps.length}
        >
          <div
            className="h-full rounded-full sp-gradient-primary transition-[width] duration-500"
            style={{ width: `${((currentIndex + 1) / steps.length) * 100}%` }}
          />
        </div>
      </div>
    </>
  );
}

const shortDescriptors: Record<string, string> = {
  connect: "Authorize your store",
  business: "Industry & brand style",
  catalog: "Upload & map products",
  blueprint: "Collections & pages",
  build: "Automated assembly",
  launch: "Final review",
};
