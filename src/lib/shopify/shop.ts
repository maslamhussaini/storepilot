/**
 * Shop-domain normalization and validation.
 *
 * No `server-only` here deliberately: normalization is pure string logic with
 * no secret material, and the Connect-step UI benefits from running the same
 * validator client-side for instant feedback (a convenience check only — the
 * authorize Route Handler re-validates server-side, authoritatively).
 */

const SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

/**
 * Accepts either a bare shop handle ("royal-oud") or a full domain
 * ("royal-oud.myshopify.com"), and returns the canonical full domain, or
 * `null` if the input can never be made into a valid one.
 *
 * This does NOT guarantee the shop exists — only that the string is shaped
 * like a real myshopify.com domain. Existence is proven by Shopify actually
 * redirecting back through the authorization flow.
 */
export function normalizeShopDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  const candidate = trimmed.includes(".") ? trimmed : `${trimmed}.myshopify.com`;

  return isValidShopDomain(candidate) ? candidate : null;
}

/** Strict validator for an already-fully-qualified domain — e.g. Shopify's own `shop` callback param. */
export function isValidShopDomain(domain: string): boolean {
  return SHOP_DOMAIN_RE.test(domain);
}
