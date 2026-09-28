import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

/**
 * Single shared service-role client factory.
 *
 * This is the ONLY module in the codebase that reads
 * `SUPABASE_SERVICE_ROLE_KEY` directly. Both `src/lib/shopify/tokens.ts`
 * and `src/lib/projects/actions.ts` import from here.
 *
 * SECURITY INVARIANTS (all load-bearing):
 *   * `import "server-only"` — a Client Component import is a BUILD error.
 *   * `SUPABASE_SERVICE_ROLE_KEY` is read ONLY here, never from
 *     `src/lib/supabase/env.ts` (which is shared with client code and must
 *     therefore only ever touch `NEXT_PUBLIC_*`), and never from a
 *     `NEXT_PUBLIC_*` variable.
 *   * `auth: { persistSession: false }` — this client must never write
 *     cookies or attempt token refresh; it is a pure server credential.
 */

function getServiceRoleEnv(): { url: string; serviceRoleKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

/**
 * Returns a service-role client, or `null` when the server credential is not
 * configured. Callers must fail CLOSED on `null` (refuse to report success),
 * never fall back to the anon key.
 */
export function getServiceRoleClient(): SupabaseClient<Database> | null {
  const env = getServiceRoleEnv();
  if (!env) return null;

  return createClient<Database>(env.url, env.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/** True when the service-role server credential is configured. */
export function isServiceRoleConfigured(): boolean {
  return getServiceRoleEnv() !== null;
}