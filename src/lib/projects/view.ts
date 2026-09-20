import type { SpProject } from "@/lib/supabase/types";
import { industries } from "@/data/wizard";
import { getStep, wizardPath } from "@/lib/wizard/steps";

/**
 * Maps a database row to what the dashboard card renders.
 *
 * Kept separate from the component so the card stays a dumb presentational
 * piece (unchanged from Phase 1) and all the "what does status 'in_progress'
 * look like to a merchant" decisions live in one place.
 */

export type BadgeTone = "success" | "progress" | "neutral" | "warning" | "danger";

export interface ProjectCardModel {
  id: string;
  name: string;
  industryLabel: string;
  statusLabel: string;
  statusTone: BadgeTone;
  readiness: number;
  /** Deep link to the project's persisted wizard position. */
  continueHref: string;
  updatedLabel: string;
}

const INDUSTRY_LABELS = new Map(industries.map((i) => [i.id, i.label]));

const STATUS_PRESENTATION: Record<
  SpProject["status"],
  { label: string; tone: BadgeTone }
> = {
  draft: { label: "Draft", tone: "neutral" },
  in_progress: { label: "In progress", tone: "progress" },
  ready: { label: "Ready for review", tone: "success" },
  archived: { label: "Archived", tone: "neutral" },
};

export function toProjectCardModel(project: SpProject): ProjectCardModel {
  const presentation = STATUS_PRESENTATION[project.status] ?? {
    label: "Draft",
    tone: "neutral" as const,
  };

  return {
    id: project.id,
    name: project.name || "Untitled Store",
    // Falls back to the wizard step description so the card is never blank for
    // a project that hasn't reached the Business step yet.
    industryLabel:
      (project.industry ? INDUSTRY_LABELS.get(project.industry) : undefined) ??
      `Next: ${getStep(project.current_step).label}`,
    statusLabel: presentation.label,
    statusTone: presentation.tone,
    readiness: project.progress_percent,
    continueHref: wizardPath(project.id, project.current_step),
    updatedLabel: formatUpdated(project.updated_at),
  };
}

/**
 * Renders as a fixed `YYYY-MM-DD` in UTC rather than a locale string, because
 * this runs on the server and any locale/timezone-dependent formatting would
 * mismatch on hydration.
 */
function formatUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 10);
}
