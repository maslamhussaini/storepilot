import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "@/lib/supabase/env";
import type { Database } from "@/lib/supabase/types";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * Every query made through this client carries the *end user's* access token,
 * so PostgreSQL evaluates our Row Level Security policies with the correct
 * `auth.uid()`. We never use the service-role key, which would bypass RLS
 * entirely — see `src/lib/supabase/env.ts`.
 *
 * `import "server-only"` makes it a build-time error for any Client Component
 * to import this module, which is the guardrail that keeps the cookie store
 * (and any future privileged code) out of the browser bundle.
 */
export async function createSupabaseServerClient() {
  const env = getSupabaseEnv();
  if (!env) {
    throw new SupabaseNotConfiguredError();
  }

  const cookieStore = await cookies();

  return createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `cookies()` is read-only inside a Server Component render. Supabase
          // still hands us refreshed tokens here, and swallowing the write is
          // the documented, correct behaviour: `src/proxy.ts` runs on every
          // matched request and performs the actual cookie refresh, so the
          // rotated token is never lost.
        }
      },
    },
  });
}

/**
 * Thrown when the app is running without Supabase credentials. Callers map this
 * to a friendly "we can't reach our servers" state rather than surfacing it.
 */
export class SupabaseNotConfiguredError extends Error {
  constructor() {
    super("Supabase is not configured (missing NEXT_PUBLIC_SUPABASE_* env vars)");
    this.name = "SupabaseNotConfiguredError";
  }
}
