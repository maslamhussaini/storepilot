import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";

const variantClasses: Record<Variant, string> = {
  // Uses the real .sp-btn-primary CSS class, not an arbitrary Tailwind background
  // utility referencing a CSS custom property, so the gradient and white text
  // always render — see globals.css comment for why that pattern is unsafe here.
  primary: "sp-btn-primary",
  secondary:
    "bg-white text-[var(--sp-emerald-800)] border border-[var(--sp-border-strong)] hover:bg-[var(--sp-mint-100)] hover:border-[var(--sp-green-500)]/40 dark:bg-[var(--sp-surface)] dark:text-[var(--sp-mint-200)] dark:hover:bg-white/5",
  ghost:
    "bg-transparent text-[var(--sp-emerald-700)] hover:bg-[var(--sp-mint-100)] dark:text-[var(--sp-mint-200)] dark:hover:bg-white/5",
};

const base =
  "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none disabled:translate-y-0";

export function GradientButton({
  children,
  variant = "primary",
  className = "",
  href,
  ...rest
}: {
  children: ReactNode;
  variant?: Variant;
  className?: string;
  href?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = `${base} ${variantClasses[variant]} ${className}`;

  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }

  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}
