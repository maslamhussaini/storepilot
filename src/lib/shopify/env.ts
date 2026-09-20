import "server-only";

/**
 * Shopify environment access — server-only, mirrors `src/lib/supabase/env.ts`'s
 * shape and rationale exactly.
 *
 * Every one of these is consumed exclusively by server-side code (Route
 * Handlers, and later, SECURITY DEFINER-backed server actions). None is
 * prefixed `NEXT_PUBLIC_*`, and this module carries `import "server-only"` so
 * an accidental import from a Client Component is a build-time error, not a
 * runtime credential leak.
 *
 * Required scalar values are trimmed at the boundary to guard against
 * accidental CR/LF/whitespace contamination from platform env UIs or CLI
 * pipelines. SHOPIFY_SCOPES is optional: missing/empty/whitespace-only values
 * all resolve to the empty string, which is the Phase 2B zero-scope setting.
 */

export interface ShopifyEnv {
  clientId: string;
  clientSecret: string;
  appUrl: string;
  apiVersion: string;
  scopes: string;
}

function trimOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Returns Shopify OAuth settings, or `null` when required values are not configured. */
export function getShopifyEnv(): ShopifyEnv | null {
  const clientId = trimOrNull(process.env.SHOPIFY_CLIENT_ID);
  const clientSecret = trimOrNull(process.env.SHOPIFY_CLIENT_SECRET);
  const appUrl = trimOrNull(process.env.SHOPIFY_APP_URL);
  const apiVersion = trimOrNull(process.env.SHOPIFY_API_VERSION);

  if (!clientId || !clientSecret || !appUrl || !apiVersion) return null;

  const scopes = process.env.SHOPIFY_SCOPES?.trim() ?? "";

  return { clientId, clientSecret, appUrl, apiVersion, scopes };
}
