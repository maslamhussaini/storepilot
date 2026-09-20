import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shopify's OAuth callback HMAC (query-string based) — verifies the redirect
 * genuinely came from Shopify, using the app's client secret.
 *
 * Algorithm (per shopify.dev, "Implement authorization code grant manually"):
 * remove `hmac` from the query string, sort the remaining keys
 * lexicographically, join as `key=value` pairs with `&`, compute HMAC-SHA256
 * over that string with the client secret, compare against the `hmac` param
 * using constant-time comparison.
 *
 * This is a DIFFERENT mechanism from the webhook HMAC (`X-Shopify-Hmac-Sha256`
 * header over the raw request body) — deliberately not shared with
 * `state.ts`'s cookie-integrity signing either, despite both using HMAC-SHA256
 * under the hood, because the three operate over different data with
 * different trust boundaries. Do not consolidate them into one "verify HMAC"
 * helper; keep the distinct inputs explicit.
 */
export function verifyShopifyOAuthCallbackHmac(
  searchParams: URLSearchParams,
  clientSecret: string,
): boolean {
  const providedHmac = searchParams.get("hmac");
  if (!providedHmac) return false;

  const pairs: string[] = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === "hmac") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const message = pairs.join("&");

  const expected = createHmac("sha256", clientSecret).update(message).digest("hex");

  const a = Buffer.from(providedHmac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
