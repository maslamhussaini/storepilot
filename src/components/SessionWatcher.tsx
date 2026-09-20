"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Keeps an open tab honest about the session.
 *
 * Without this, a merchant who signs out in one tab (or whose refresh token is
 * revoked server-side) keeps looking at a rendered dashboard in another tab
 * until they happen to navigate. Any action they take then fails confusingly.
 *
 * On a sign-out or token-refresh event we call `router.refresh()`, which
 * re-runs the Server Components. The server re-reads the session, finds it
 * gone, and `requireUser()` redirects to /login — a clean, server-verified
 * transition rather than a client-side guess about auth state.
 *
 * Renders nothing. This is the only place the browser Supabase client is used;
 * no project data is ever fetched client-side.
 */
export function SessionWatcher() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT" || event === "TOKEN_REFRESHED") {
        router.refresh();
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  return null;
}
