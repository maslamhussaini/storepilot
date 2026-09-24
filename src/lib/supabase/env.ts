/**
 * Supabase environment access.
 *
 * SECURITY: this module is imported by BOTH server and client code, so it may
 * only ever touch `NEXT_PUBLIC_*` variables. The service-role key
 * (`SUPABASE_SERVICE_ROLE_KEY`) is deliberately never referenced HERE — every
 * database operation made through clients built from this module runs under
 * the calling user's own session so that Row Level Security stays in force.
 * If that key were read here it would be inlined into the browser bundle by
 * the Next.js bundler and would hand every visitor RLS-bypassing access.
 * Since Phase 2B.3B-1 the service-role key IS read in exactly one place:
 * `src/lib/shopify/tokens.ts`, a `server-only` module — never in this shared
 * module, never from a `NEXT_PUBLIC_*` variable.
 *
 * KEY NAME: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is Supabase's current
 * browser-safe key name (their newer `sb_publishable_…` key format). Earlier
 * Supabase projects issued a legacy anon JWT under
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` instead; that variable is still read as a
 * fallback so an older project's `.env.local` keeps working unchanged, but
 * any project created going forward should use the publishable-key name.
 * Both are equally public-by-design: on their own they grant nothing,
 * because every table is protected by Row Level Security.
 *
 * The reads below are written as literal `process.env.NEXT_PUBLIC_…` member
 * expressions on purpose: Next.js only inlines that exact syntactic shape.
 * Destructuring or dynamic indexing would silently yield `undefined` in the
 * browser.
 */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

/**
 * Returns the Supabase connection settings, or `null` when the app has not
 * been configured yet.
 *
 * Returning `null` instead of throwing is what lets `npm run build` succeed on
 * a machine with no `.env.local`, and lets the UI render a calm
 * "we can't reach our servers right now" state instead of a stack trace when
 * configuration is missing in production.
 */
export function getSupabaseEnv(): SupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** True when Supabase credentials are present. */
export function isSupabaseConfigured(): boolean {
  return getSupabaseEnv() !== null;
}
