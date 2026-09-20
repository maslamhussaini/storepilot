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
 */

export interface ShopifyEnv {
  clientId: string;
  clientSecret: string;
  appUrl: string;
  apiVersion: string;
}

/** Returns Shopify OAuth settings, or `null` when not yet configured. */
export function getShopifyEnv(): ShopifyEnv | null {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL;
  const apiVersion = process.env.SHOPIFY_API_VERSION;

  if (!clientId || !clientSecret || !appUrl || !apiVersion) return null;
  return { clientId, clientSecret, appUrl, apiVersion };
}
