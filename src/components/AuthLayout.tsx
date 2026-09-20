import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/BrandMark";

/**
 * Shell for /login and /signup.
 *
 * Reuses the Phase 1 visual language verbatim — the same `sp-gradient-dark`
 * hero panel, `sp-glow-orb`, mint accent type and floating card decorations as
 * the dashboard hero, and the same bordered `sp-surface` card as the wizard.
 * Nothing new is designed here; the panel is the dashboard hero re-laid out as
 * a two-column split that collapses to a single column on mobile.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--sp-border)] bg-[var(--sp-surface)]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center px-4 py-3.5 sm:px-6">
          <Link href="/login" className="flex items-center gap-2.5">
            <BrandMark />
            <span className="text-[17px] font-semibold tracking-tight">StorePilot</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 items-center px-4 py-8 sm:px-6">
        <div className="sp-animate-in grid w-full grid-cols-1 items-stretch gap-8 lg:grid-cols-2">
          {/* Brand panel — hidden on small screens so the form stays above the fold */}
          <section className="relative hidden overflow-hidden rounded-3xl border border-[var(--sp-border)] sp-gradient-dark px-8 py-12 text-white lg:block">
            <div
              aria-hidden="true"
              className="sp-glow-orb pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full opacity-70"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-6 bottom-8 hidden h-56 w-72 lg:block"
            >
              <div className="absolute right-4 top-2 h-24 w-32 -rotate-6 rounded-xl border border-white/15 bg-white/10 backdrop-blur-sm" />
              <div className="absolute right-24 top-16 h-20 w-28 rotate-3 rounded-xl border border-white/15 bg-white/10 backdrop-blur-sm" />
              <div className="absolute right-0 bottom-2 h-16 w-24 rotate-12 rounded-xl border border-[var(--sp-mint-300)]/40 bg-[var(--sp-mint-300)]/10 backdrop-blur-sm" />
            </div>

            <div className="relative max-w-sm">
              <p className="text-xs font-semibold uppercase tracking-widest text-[var(--sp-mint-300)]">
                StorePilot
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight">
                Launch your next store in minutes.
              </h2>
              <p className="mt-3 text-sm text-white/75">
                Turn a product spreadsheet into a structured, launch-ready Shopify store.
                Your projects are saved to your account, so you can pick up exactly where
                you left off.
              </p>
            </div>
          </section>

          {/* Form card */}
          <section className="flex items-center">
            <div className="w-full rounded-2xl border border-[var(--sp-border)] bg-[var(--sp-surface)] p-6 shadow-sm sm:p-8">
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              <p className="mt-1 text-sm text-[var(--sp-muted)]">{subtitle}</p>
              <div className="mt-6">{children}</div>
              <div className="mt-6 border-t border-[var(--sp-border)] pt-5 text-sm text-[var(--sp-muted)]">
                {footer}
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="border-t border-[var(--sp-border)] py-6 text-center text-xs text-[var(--sp-muted)]">
        StorePilot Phase 2A — real accounts, demo store build. No live Shopify connection.
      </footer>
    </div>
  );
}
