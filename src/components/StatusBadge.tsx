type Tone = "success" | "progress" | "neutral" | "warning" | "danger";

const toneStyles: Record<Tone, string> = {
  success: "bg-[var(--sp-mint-100)] text-[var(--sp-emerald-800)]",
  progress: "bg-[#fff4dd] text-[#8a5a00]",
  neutral: "bg-black/5 text-[var(--sp-muted)] dark:bg-white/10",
  warning: "bg-[#fff0e0] text-[#a3510a]",
  danger: "bg-[#fde8e8] text-[#b42318]",
};

const toneIcon: Record<Tone, string> = {
  success: "●",
  progress: "◐",
  neutral: "○",
  warning: "▲",
  danger: "✕",
};

export function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${toneStyles[tone]}`}
    >
      <span aria-hidden="true">{toneIcon[tone]}</span>
      {label}
    </span>
  );
}

export function statusToTone(status: string): Tone {
  switch (status) {
    case "Ready for review":
    case "Launched":
      return "success";
    case "Catalog imported":
    case "Building":
      return "progress";
    case "Draft":
      return "neutral";
    default:
      return "neutral";
  }
}
