"use client";

import { useEffect, useState } from "react";

export function ReadinessScore({ score }: { score: number }) {
  const [display, setDisplay] = useState(0);
  const circumference = 2 * Math.PI * 54;
  const offset = circumference - (display / 100) * circumference;

  useEffect(() => {
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      const id = requestAnimationFrame(() => setDisplay(score));
      return () => cancelAnimationFrame(id);
    }
    let raf: number;
    const start = performance.now();
    const duration = 1100;
    function tick(now: number) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(eased * score));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [score]);

  return (
    <div className="flex flex-col items-center">
      <div className="relative h-36 w-36">
        <div
          aria-hidden="true"
          className="sp-glow-orb absolute inset-[-20%] rounded-full opacity-60"
        />
        <svg viewBox="0 0 120 120" className="relative h-full w-full -rotate-90">
          <circle
            cx="60"
            cy="60"
            r="54"
            fill="none"
            stroke="currentColor"
            className="text-black/5 dark:text-white/10"
            strokeWidth="10"
          />
          <circle
            cx="60"
            cy="60"
            r="54"
            fill="none"
            stroke="url(#sp-readiness-gradient)"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
          <defs>
            <linearGradient id="sp-readiness-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--sp-emerald-800)" />
              <stop offset="100%" stopColor="var(--sp-mint-300)" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold tabular-nums">{display}%</span>
          <span className="text-[10px] uppercase tracking-wide text-[var(--sp-muted)]">
            Ready
          </span>
        </div>
      </div>
    </div>
  );
}
