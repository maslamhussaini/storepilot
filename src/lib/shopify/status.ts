/**
 * Phase 2B.3B-1 — the SAFE Shopify connection DTO, shared by server and
 * client code.
 *
 * Deliberately lives in a plain module WITHOUT `import "server-only"` (it is
 * pure type-level data — zero runtime code, zero credentials) so the Server
 * Component that fetches it and the Client Component that renders it can
 * both import the same definition instead of drifting copies.
 *
 * EXPLICIT ALLOW-LIST — a field may be added here only if it is safe to send
 * to the browser. Never: vault_secret_id, access_token, refresh_token,
 * token expiry internals, service-role material, OAuth state, or raw error
 * detail. The backing read (`get_connection_metadata` in SQL) enforces the
 * same list at the database, so a mistake here still cannot leak a secret —
 * the two lists must stay in agreement.
 */
export interface ShopifyConnectionStatus {
  /** True only when a connection row exists with status === "connected". */
  connected: boolean;
  /** Normalized shop domain (e.g. "0tsfz1-eg.myshopify.com"), or null. */
  shopDomain: string | null;
  /**
   * "connected" | "reauth_required" | "disconnected" | "uninstalled",
   * or null when no connection record exists for the project yet.
   */
  status: "connected" | "reauth_required" | "disconnected" | "uninstalled" | null;
  /** ISO timestamp of first successful install, or null. Non-secret. */
  installedAt: string | null;
}

/** The fail-closed "no connection known" value. */
export const NO_CONNECTION: ShopifyConnectionStatus = {
  connected: false,
  shopDomain: null,
  status: null,
  installedAt: null,
};
