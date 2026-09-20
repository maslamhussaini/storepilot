import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import {
  createSupabaseServerClient,
  SupabaseNotConfiguredError,
} from "@/lib/supabase/server";

/**
 * Data Access Layer — authentication.
 *
 * Following the Next.js "Data Access Layer" recommendation
 * (`docs/01-app/02-guides/data-security.md`): a single internal module decides
 * who the caller is, and every protected read/write funnels through it. Pages
 * and actions never reach for the session themselves.
 *
 * `src/proxy.ts` also redirects unauthenticated users, but that is a UX
 * nicety. These functions are the real check, because Server Actions are POSTs
 * to the page route and a matcher change could silently remove proxy coverage
 * (see the warning in the Next.js proxy docs). Underneath both sits Postgres
 * RLS, which is the actual security boundary.
 */

export type AuthResult =
  | { status: "authenticated"; user: User }
  | { status: "anonymous" }
  | { status: "unavailable" };

/**
 * Reads the current user, verified against the Supabase Auth server.
 *
 * `cache()` dedupes this across a single render pass, so a layout, a page and
 * three components asking "who is the user?" cost one round trip, not five.
 *
 * Always `getUser()`, never `getSession()`: `getSession()` merely decodes the
 * cookie the browser sent, which is attacker-controlled. `getUser()` validates
 * the JWT with the auth server.
 */
export const getAuth = cache(async (): Promise<AuthResult> => {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return { status: "anonymous" };
    return { status: "authenticated", user: data.user };
  } catch (error) {
    if (error instanceof SupabaseNotConfiguredError) {
      return { status: "unavailable" };
    }
    // Network failure / Supabase outage. Distinct from "anonymous" so callers
    // can show "we can't reach our servers" instead of bouncing to /login,
    // which would be a confusing lie.
    return { status: "unavailable" };
  }
});

/** Convenience: the user or null. Does not redirect. */
export async function getCurrentUser(): Promise<User | null> {
  const auth = await getAuth();
  return auth.status === "authenticated" ? auth.user : null;
}

/**
 * Requires an authenticated user, redirecting to /login otherwise.
 * Use at the top of every protected page and every mutating server action.
 *
 * Note: `redirect()` throws a control-flow signal, so code after this call is
 * unreachable for unauthenticated callers — TypeScript narrows the return to
 * `User` correctly.
 */
export async function requireUser(): Promise<User> {
  const auth = await getAuth();
  if (auth.status === "authenticated") return auth.user;
  redirect("/login");
}

/** A short, stable display label for the account chip in the header. */
export function userInitials(user: { email?: string | null }): string {
  const email = user.email ?? "";
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return (local.slice(0, 2) || "SP").toUpperCase();
}
