"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/supabase/env";
import type { Database } from "@/lib/supabase/types";

/**
 * Supabase client for Client Components.
 *
 * Phase 2A deliberately keeps this on a short leash: all authentication and
 * all reads/writes go through Server Actions and Server Components, so the
 * browser client has exactly one consumer — `src/components/SessionWatcher.tsx`,
 * which subscribes to auth state changes so the UI reacts when a session is
 * revoked or expires in another tab. No project data is ever fetched here.
 *
 * Only the anon key is used, and it is public by design: it grants nothing on
 * its own because every table is protected by RLS.
 */
export function createSupabaseBrowserClient() {
  const env = getSupabaseEnv();
  // Returning null rather than throwing keeps the app renderable when the
  // deployment has no Supabase credentials configured.
  if (!env) return null;

  return createBrowserClient<Database>(env.url, env.anonKey);
}
