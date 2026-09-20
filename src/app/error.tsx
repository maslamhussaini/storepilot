"use client";

import { useEffect } from "react";
import { GradientButton } from "@/components/GradientButton";
import { BrandMark } from "@/components/BrandMark";

/**
 * Last-resort error boundary.
 *
 * Merchants never see a stack trace or a database message: Next.js already
 * redacts server error details in production, and this boundary shows a calm,
 * on-brand recovery screen regardless. The real cause goes to the server log
 * via the `console.error` below (and `error.digest`, which correlates the
 * message the user saw with the server-side log line).
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] unhandled error:", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <BrandMark />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 max-w-md text-sm text-[var(--sp-muted)]">
        We hit an unexpected problem. Your saved work is safe — please try again in a
        moment.
      </p>
      {error.digest ? (
        <p className="mt-2 text-xs text-[var(--sp-muted)]">
          Reference: <span className="font-mono">{error.digest}</span>
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <GradientButton onClick={reset} type="button">
          Try again
        </GradientButton>
        <GradientButton href="/" variant="secondary">
          Back to dashboard
        </GradientButton>
      </div>
    </div>
  );
}
