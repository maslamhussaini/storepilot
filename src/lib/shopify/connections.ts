import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ShopifyConnectionStatus } from "@/lib/shopify/status";
import { isUuid } from "@/lib/projects/queries";

/** Closed set of statuses the DTO accepts — mirrors the table's CHECK. */
type ConnectionStatusName = NonNullable<ShopifyConnectionStatus["status"]>;
const TO_CONNECTION_STATUSES: readonly string[] = [
  "connected",
  "reauth_required",
  "disconnected",
  "uninstalled",
];

/**
 * Phase 2B.3B-1 — durable, SAFE connection read for the Connect wizard.
 *
 * Goes through the 2B.3A `get_connection_metadata` SECURITY DEFINER function
 * under the CALLING USER'S OWN session (RLS semantics preserved):
 *   * EXECUTE granted to `authenticated` only (plus service_role);
 *   * the function checks `auth.uid()` owns the project before returning a
 *     row, so a tampered projectId yields zero rows, not another tenant's.
 *
 * The returned DTO is an explicit allow-list — see `ShopifyConnectionStatus`
 * in `status.ts`. By construction it can never contain: vault_secret_id,
 * access token, refresh token, expiry internals, or any service-role
 * information. It is safe to hand to a Server Component → Client Component
 * prop boundary.
 *
 * NOT derived from query params, cookies we control, or sessionStorage —
 * this function IS the single source of truth for "connected?" in the UI.
 *
 * Fail-closed contract: `null` means "could not determine" (network error,
 * schema missing, unauthenticated) and callers must present that as NOT
 * connected.
 */
export async function getConnectionStatus(
  projectId: string,
): Promise<ShopifyConnectionStatus | null> {
  // Reject non-UUIDs before PostgREST ever sees them (a bad uuid literal
  // returns a 400 we would otherwise have to translate).
  if (!isUuid(projectId)) return null;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("get_connection_metadata", {
      p_project_id: projectId,
    });

    if (error) {
      // Logged for operators; never surfaced to the merchant with detail.
      console.error("[shopify connections] get_connection_metadata failed:", error.message);
      return null;
    }

    const row = Array.isArray(data) ? data[0] : undefined;
    if (!row) {
      return { connected: false, shopDomain: null, status: null, installedAt: null };
    }

    // The RPC's `status` column arrives as plain `string`; narrow it to the
    // DTO's closed union so an unexpected value degrades to `null` (unknown)
    // instead of leaking through as an unchecked literal.
    const status = TO_CONNECTION_STATUSES.includes(row.status as ConnectionStatusName)
      ? (row.status as ConnectionStatusName)
      : null;

    return {
      connected: row.status === "connected",
      shopDomain: row.shop_domain,
      status,
      installedAt: row.installed_at,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "SupabaseNotConfiguredError") {
      return null;
    }
    console.error("[shopify connections] getConnectionStatus threw:", error);
    return null;
  }
}
