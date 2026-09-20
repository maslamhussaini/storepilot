import type { DashboardMetric } from "@/data/projects";

export function MetricCard({ metric }: { metric: DashboardMetric }) {
  return (
    <div className="rounded-2xl border border-[var(--sp-border)] bg-[var(--sp-surface)] p-5 shadow-sm">
      <p className="text-sm text-[var(--sp-muted)]">{metric.label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight">{metric.value}</p>
      <p className="mt-1 text-xs text-[var(--sp-muted)]">{metric.helpText}</p>
    </div>
  );
}
