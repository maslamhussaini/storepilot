import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import type { ProjectCardModel } from "@/lib/projects/view";

/**
 * Dashboard project card.
 *
 * Phase 2A: identical markup and classes to Phase 1 — only the data source
 * changed (a real `sp_projects` row, mapped by `toProjectCardModel`) and two
 * substitutions:
 *   * the href now deep-links to the project's PERSISTED wizard step, so
 *     "Continue" resumes exactly where the merchant left off;
 *   * the bottom-left slot shows the last-updated date instead of a product
 *     count, because Phase 2A stores no products and printing a fabricated
 *     count next to real data would be misleading.
 */
function initials(name: string) {
  return (
    name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "S"
  );
}

export function ProjectCard({ project }: { project: ProjectCardModel }) {
  const nearlyReady = project.readiness >= 90;
  return (
    <Link
      href={project.continueHref}
      className={`sp-card-hover group block rounded-2xl border bg-[var(--sp-surface)] p-6 shadow-sm ${
        nearlyReady ? "border-[var(--sp-green-500)]/40" : "border-[var(--sp-border)]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl sp-gradient-primary text-sm font-semibold text-white"
          >
            {initials(project.name)}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-lg font-semibold leading-tight">{project.name}</h3>
            <p className="truncate text-sm text-[var(--sp-muted)]">{project.industryLabel}</p>
          </div>
        </div>
        <StatusBadge label={project.statusLabel} tone={project.statusTone} />
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between text-xs text-[var(--sp-muted)]">
          <span>Readiness</span>
          <span
            className={`font-semibold ${
              nearlyReady ? "text-[var(--sp-green-500)]" : "text-[var(--foreground)]"
            }`}
          >
            {project.readiness}%
          </span>
        </div>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
          <div
            className="h-full rounded-full sp-gradient-primary transition-[width] duration-500"
            style={{ width: `${project.readiness}%` }}
          />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-[var(--sp-muted)]">Updated {project.updatedLabel}</span>
        <span className="font-medium text-[var(--sp-green-500)] group-hover:underline">
          Continue →
        </span>
      </div>
    </Link>
  );
}
