export function ActivityFeed({ lines, active = false }: { lines: string[]; active?: boolean }) {
  return (
    <div
      aria-live="polite"
      aria-label="Build activity feed"
      className="max-h-64 overflow-y-auto rounded-xl sp-gradient-dark p-4 text-xs text-[var(--sp-mint-200)]"
    >
      {lines.length === 0 ? (
        <p className="text-white/40">Waiting to start…</p>
      ) : (
        <ul className="space-y-1.5">
          {lines.map((line, i) => {
            const isLast = i === lines.length - 1;
            return (
              <li
                key={i}
                className={`sp-animate-in flex items-center gap-2 ${
                  isLast && active ? "sp-pulse text-white" : ""
                }`}
              >
                {line}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
