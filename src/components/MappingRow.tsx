import type { MappingRowData } from "@/data/wizard";

export function MappingRow({ mapping }: { mapping: MappingRowData }) {
  const tone =
    mapping.confidence >= 95 ? "high" : mapping.confidence >= 85 ? "medium" : "low";

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--sp-border)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2 font-medium">
        <span className="rounded-md bg-black/5 px-2 py-1 dark:bg-white/10">{mapping.source}</span>
        <span aria-hidden="true" className="text-[var(--sp-muted)]">
          →
        </span>
        <span className="rounded-md bg-[var(--sp-mint-100)] px-2 py-1 text-[var(--sp-emerald-800)] dark:bg-white/10 dark:text-[var(--sp-mint-200)]">
          {mapping.target}
        </span>
      </div>
      <span
        className={`inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
          tone === "high"
            ? "bg-[var(--sp-mint-100)] text-[var(--sp-emerald-800)]"
            : tone === "medium"
            ? "bg-[#fff4dd] text-[#8a5a00]"
            : "bg-[#fff0e0] text-[#a3510a]"
        }`}
      >
        {mapping.confidence}% match
      </span>
    </div>
  );
}
