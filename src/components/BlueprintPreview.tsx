type StylePreset = {
  font: string;
  heroBg: string;
  accent: string;
  radius: string;
};

const presets: Record<string, StylePreset> = {
  luxury: {
    font: "font-serif tracking-wide",
    heroBg: "linear-gradient(135deg, #0a3324 0%, #052e24 100%)",
    accent: "#a7f3d0",
    radius: "rounded-none",
  },
  modern: {
    font: "font-sans tracking-tight",
    heroBg: "linear-gradient(135deg, #047857 0%, #10b981 100%)",
    accent: "#ffffff",
    radius: "rounded-lg",
  },
  minimal: {
    font: "font-sans tracking-tight",
    heroBg: "#f4f7f5",
    accent: "#0a3324",
    radius: "rounded-md",
  },
  playful: {
    font: "font-sans",
    heroBg: "linear-gradient(135deg, #2ec27e 0%, #a7f3d0 100%)",
    accent: "#052e24",
    radius: "rounded-2xl",
  },
};

export function BlueprintPreview({ style, storeName }: { style: string; storeName: string }) {
  const preset = presets[style] ?? presets.modern;
  const name = (storeName || "Your Store").toUpperCase();
  const isLightHero = style === "minimal";

  return (
    <div
      aria-label={`Miniature storefront preview in ${style} style`}
      className="overflow-hidden rounded-2xl border border-[var(--sp-border)] bg-white shadow-sm dark:bg-[var(--sp-surface)]"
    >
      {/* browser chrome */}
      <div className="flex items-center gap-1.5 border-b border-[var(--sp-border)] bg-black/[.03] px-3 py-2 dark:bg-white/5">
        <span className="h-2.5 w-2.5 rounded-full bg-red-300" aria-hidden="true" />
        <span className="h-2.5 w-2.5 rounded-full bg-yellow-300" aria-hidden="true" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-300" aria-hidden="true" />
        <span className="ml-3 truncate text-xs text-[var(--sp-muted)]">
          preview.storepilot.app/{storeName.toLowerCase().replace(/\s+/g, "-") || "your-store"}
        </span>
      </div>

      {/* store nav */}
      <div
        className={`flex items-center justify-between border-b border-[var(--sp-border)] px-5 py-2.5 text-[11px] font-medium ${preset.font}`}
        style={{ color: isLightHero ? "#0a3324" : undefined }}
      >
        <span className="font-bold tracking-widest">{name}</span>
        <div className="hidden gap-3 opacity-70 sm:flex">
          <span>Shop</span>
          <span>Collections</span>
          <span>About</span>
        </div>
        <span aria-hidden="true">🛒</span>
      </div>

      {/* hero */}
      <div
        className={`px-6 py-9 text-center ${preset.font}`}
        style={{ background: preset.heroBg, color: isLightHero ? "#0a3324" : "#ffffff" }}
      >
        <p className="text-[10px] uppercase tracking-[0.3em] opacity-75">{style} theme</p>
        <h3 className="mt-2 text-2xl font-semibold">Discover timeless fragrance</h3>
        <button
          type="button"
          tabIndex={-1}
          className={`mt-4 inline-block px-4 py-1.5 text-xs font-semibold ${preset.radius}`}
          style={{
            background: isLightHero ? "#0a3324" : "rgba(255,255,255,0.16)",
            color: isLightHero ? "#ffffff" : preset.accent,
            border: isLightHero ? "none" : `1px solid ${preset.accent}66`,
          }}
        >
          Shop Collection
        </button>
      </div>

      {/* new arrivals / product grid */}
      <div className="p-4">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--sp-muted)]">
          New Arrivals
        </p>
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-1.5">
              <div className={`aspect-square ${preset.radius} bg-[var(--sp-mint-100)] dark:bg-white/10`} />
              <div className="h-2 w-3/4 rounded bg-black/10 dark:bg-white/10" />
              <div className="h-2 w-1/2 rounded bg-black/5 dark:bg-white/5" />
            </div>
          ))}
        </div>

        <p className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-widest text-[var(--sp-muted)]">
          Collections
        </p>
        <div className="flex gap-2">
          {["Oud", "Gift Sets", "Best Sellers"].map((c) => (
            <span
              key={c}
              className={`px-2.5 py-1 text-[10px] font-medium ${preset.radius} bg-black/[.04] dark:bg-white/10`}
            >
              {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
