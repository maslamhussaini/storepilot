import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

/**
 * 404. Reached by `notFound()` from the wizard route when the step key isn't
 * one of the six, and by any unmatched URL. Deliberately says nothing about
 * whether a resource exists — see `getProjectWithProfile`, which collapses
 * "missing" and "not yours" into the same outcome.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <BrandMark />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        We couldn&apos;t find that page
      </h1>
      <p className="mt-2 max-w-sm text-sm text-[var(--sp-muted)]">
        The link may be out of date, or the page may have moved.
      </p>
      <Link
        href="/"
        className="sp-btn-primary mt-6 inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-all duration-200"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
