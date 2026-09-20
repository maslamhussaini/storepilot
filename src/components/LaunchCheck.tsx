import type { ReadinessBucketItem } from "@/data/wizard";

type Bucket = "auto" | "review" | "action";

const bucketMeta: Record<Bucket, { label: string; tone: string; icon: string }> = {
  auto: { label: "Automated", tone: "bg-[var(--sp-mint-100)] text-[var(--sp-emerald-800)]", icon: "✓" },
  review: { label: "Needs review", tone: "bg-[#fff4dd] text-[#8a5a00]", icon: "◐" },
  action: { label: "Needs action", tone: "bg-[#fde8e8] text-[#b42318]", icon: "!" },
};

export function LaunchCheck({ bucket, items }: { bucket: Bucket; items: ReadinessBucketItem[] }) {
  const meta = bucketMeta[bucket];
  return (
    <div className="rounded-xl border border-[var(--sp-border)] p-4">
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.tone}`}>
        <span aria-hidden="true">{meta.icon}</span>
        {meta.label}
      </span>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item.label} className="text-sm">
            <p className="font-medium">{item.label}</p>
            <p className="text-xs text-[var(--sp-muted)]">{item.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
