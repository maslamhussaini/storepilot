import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/BrandMark";
import { SessionWatcher } from "@/components/SessionWatcher";
import { SubmitButton } from "@/components/SubmitButton";
import { createProjectAction } from "@/lib/projects/actions";
import { signOutAction } from "@/lib/auth/actions";
import { userInitials } from "@/lib/auth/dal";

/**
 * Application shell.
 *
 * Phase 2A changes are functional only — the markup, spacing and classes are
 * unchanged from Phase 1. What changed:
 *   * the account chip shows the real signed-in email instead of a hardcoded one
 *   * "+ New Store" is a form that creates a real project row, not a link to a
 *     global demo wizard (there is no longer a project-less wizard route)
 *   * a sign-out control was added next to the account chip
 */
export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  // Matches Supabase's `User.email`, which is optional.
  user?: { email?: string | null } | null;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Renders nothing; reacts to sign-out/token events in other tabs. */}
      <SessionWatcher />
      <header className="sticky top-0 z-40 border-b border-[var(--sp-border)] bg-[var(--sp-surface)]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark />
            <span className="text-[17px] font-semibold tracking-tight">StorePilot</span>
          </Link>

          <nav
            aria-label="Primary"
            className="hidden items-center gap-1 text-sm font-medium text-[var(--sp-muted)] sm:flex"
          >
            <Link
              href="/"
              className="rounded-full px-3 py-1.5 transition-colors hover:bg-black/[.04] hover:text-[var(--foreground)] dark:hover:bg-white/5"
            >
              Dashboard
            </Link>
          </nav>

          <div className="flex items-center gap-3">
            {/*
              A form, not a link: creating a store is a mutation. The submit
              button disables itself while pending so a double-click cannot
              create two drafts.
            */}
            <form action={createProjectAction} className="hidden sm:block">
              <SubmitButton
                className="px-4 py-2"
                pendingLabel="Creating…"
              >
                + New Store
              </SubmitButton>
            </form>

            {user ? (
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--sp-emerald-900)] text-xs font-semibold text-[var(--sp-mint-200)] ring-1 ring-[var(--sp-border-strong)]"
                  title={user.email ?? undefined}
                >
                  {userInitials(user)}
                </span>
                <span className="sr-only">Signed in as {user.email}</span>
                <form action={signOutAction}>
                  <button
                    type="submit"
                    className="rounded-full px-2.5 py-1.5 text-xs font-medium text-[var(--sp-muted)] transition-colors hover:bg-black/[.04] hover:text-[var(--foreground)] dark:hover:bg-white/5"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>

      <footer className="border-t border-[var(--sp-border)] py-6 text-center text-xs text-[var(--sp-muted)]">
        StorePilot Phase 2A — your projects are saved to your account. Catalog, Blueprint,
        Build and Launch are still demo-only; no live Shopify connection.
      </footer>
    </div>
  );
}
