import type { BuildResource } from "@/data/wizard";

export function BuildProgress({
  resources,
  progressByResource,
  overallPercent,
}: {
  resources: BuildResource[];
  progressByResource: Record<string, number>;
  overallPercent: number;
}) {
  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Overall progress</span>
          <span className="text-[var(--sp-muted)]">{Math.round(overallPercent)}%</span>
        </div>
        <div
          className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10"
          role="progressbar"
          aria-valuenow={Math.round(overallPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full sp-gradient-primary transition-[width] duration-300"
            style={{ width: `${overallPercent}%` }}
          />
        </div>
      </div>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {resources.map((resource) => {
          const done = progressByResource[resource.id] ?? 0;
          const pct = Math.min(100, (done / resource.total) * 100);
          const complete = pct >= 100;
          return (
            <li
              key={resource.id}
              className="rounded-xl border border-[var(--sp-border)] p-3"
            >
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{resource.label}</span>
                <span
                  className={`text-xs ${
                    complete ? "text-[var(--sp-green-500)]" : "text-[var(--sp-muted)]"
                  }`}
                >
                  {complete ? "✓ Done" : `${Math.min(done, resource.total)}/${resource.total}`}
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                <div
                  className="h-full rounded-full bg-[var(--sp-green-400)] transition-[width] duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
