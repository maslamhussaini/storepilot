export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="sp-mark-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--sp-emerald-800)" />
          <stop offset="55%" stopColor="var(--sp-green-500)" />
          <stop offset="100%" stopColor="var(--sp-mint-300)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#sp-mark-gradient)" />
      {/* stacked-blocks / launch mark: three ascending bars with a spark tip */}
      <rect x="7" y="19" width="5" height="7" rx="1.2" fill="white" fillOpacity="0.92" />
      <rect x="13.5" y="14" width="5" height="12" rx="1.2" fill="white" fillOpacity="0.96" />
      <rect x="20" y="8" width="5" height="18" rx="1.2" fill="white" />
      <path d="M20.5 7.5l1.6-3.3 1.6 3.3 3.3 1.6-3.3 1.6-1.6 3.3-1.6-3.3-3.3-1.6z" fill="white" />
    </svg>
  );
}
