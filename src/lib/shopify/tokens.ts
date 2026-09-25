import "server-only";

import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getShopifyEnv } from "@/lib/shopify/env";
import {
  getValidAccessTokenWithStore,
  ShopifyTokenLifecycleError,
  type ShopifyRefreshTransport,
  type ShopifyRefreshTransportResult,
  type ShopifyRefreshTokenPayload,
  type ShopifyTokenClaimResult,
  type ShopifyTokenRecord,
  type ShopifyTokenStore,
  type ValidShopifyAccessToken,
} from "@/lib/shopify/token-lifecycle";
import type { Database, Json } from "@/lib/supabase/types";

/**
 * Phase 2B.3B-1 / 2B.3B-2 — server-only Supabase SERVICE-ROLE boundary.
 *
 * The single sanctioned client for Shopify OAuth token persistence and the
 * trusted server-only token lifecycle. The database token RPCs are
 * EXECUTE-granted to `service_role` ONLY: the OAuth callback and future Admin
 * API callers run outside a trusted PostgREST user session, while granting
 * these functions to `authenticated` would expose raw Vault material.
 *
 * SECURITY INVARIANTS (all load-bearing):
 *   * `import "server-only"` — a Client Component import is a BUILD error,
 *     not a runtime leak.
 *   * `SUPABASE_SERVICE_ROLE_KEY` is read ONLY here (server-only module),
 *     never from `src/lib/supabase/env.ts` (which is shared with client code
 *     and must therefore only ever touch `NEXT_PUBLIC_*`), and never from a
 *     `NEXT_PUBLIC_*` variable.
 *   * `auth: { persistSession: false }` — this client must never write
 *     cookies or attempt token refresh; it is a pure server credential.
 *   * The only value-returning lifecycle operation is `getValidAccessToken`,
 *     which returns a raw access token exclusively to trusted server code; it
 *     is never routed through a page, client component, or API JSON response.
 *
 * OAuth persistence and lifecycle code use this boundary. Safe wizard
 * metadata reads use the user-session path (`src/lib/shopify/connections.ts`),
 * never this client.
 */

/** Trimmed at the boundary to guard against CR/LF contamination from env UIs. */
function getServiceRoleEnv(): { url: string; serviceRoleKey: string } | null {
  // NEXT_PUBLIC_SUPABASE_URL is public by design (it is inlined into the
  // browser bundle anyway); reading it server-side is safe and avoids a
  // second, divergent URL variable.
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
function getServiceRoleClient(): SupabaseClient<Database> | null {
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

/**
 * The token material handed to `store_connection_tokens`. Every field except
 * `access_token` is OPTIONAL — Shopify's expiring-token response shape does
 * not guarantee `refresh_token` / `expires_in` / `refresh_token_expires_in` /
 * `scope`, and inventing a missing field would corrupt the Vault payload or
 * the expiry metadata. Never logged, never serialized to the client.
 */
export interface ShopifyTokenPayload {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
}

/**
 * Failure of the durable-persistence step. Carries a NON-SENSITIVE reason
 * code only — the browser sees the code, DB/Vault error detail never leaves
 * the server (and the detailed, sanitized diagnostic is logged once, here).
 */
export class ShopifyPersistenceError extends Error {
  readonly code: "not_configured" | "store_failed";

  constructor(code: ShopifyPersistenceError["code"]) {
    super(`Shopify connection persistence failed: ${code}`);
    this.name = "ShopifyPersistenceError";
    this.code = code;
  }
}

/**
 * Prepares a database error message for SERVER-SIDE logs only:
 *   * truncated (a wall of Postgres detail is not actionable anyway),
 *   * JWT-shaped (`eyJ…`) and long opaque token-like substrings redacted, so
 *     even if an upstream error ever echoed material back, the log line
 *     cannot contain a usable secret.
 * Never used for anything the client sees — the client receives
 * `ShopifyPersistenceError.code` and nothing else.
 */
function sanitizeForLog(message: string): string {
  return message
    .replace(/eyJ[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]")
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/g, "[redacted]")
    .slice(0, 300);
}

/**
 * Durably persists one Shopify OAuth token payload + connection metadata +
 * lifecycle event via the 2B.3A SECURITY DEFINER primitive, which performs
 * Vault write, metadata upsert, and event insert in ONE transaction.
 *
 * FAILS CLOSED: any problem (missing server credential, RPC error, unique
 * conflict from a shop already active on another project) throws
 * `ShopifyPersistenceError` — the caller must then report failure to the
 * browser and must NOT claim success. The 2B.3A function's own atomicity
 * means a throw can never have left a half-connected row behind.
 *
 * IDEMPOTENCY: repeat authorizations for the same project/shop update the
 * active row in place and log `reconnected`; first-ever authorizations log
 * `installed` — decided inside the function, never here.
 *
 * @returns void on success; throws `ShopifyPersistenceError` otherwise.
 */
export async function storeShopifyTokens(
  projectId: string,
  shopDomain: string,
  payload: ShopifyTokenPayload,
): Promise<void> {
  const supabase = getServiceRoleClient();
  if (!supabase) {
    console.error("[shopify persistence] service-role credential not configured", {
      projectId,
      shopDomain,
    });
    throw new ShopifyPersistenceError("not_configured");
  }

  const { error } = await supabase.rpc("store_connection_tokens", {
    p_project_id: projectId,
    p_shop_domain: shopDomain,
    // The function itself whitelists the Vault payload to exactly
    // {access_token, refresh_token} — nothing else in here can reach Vault.
    p_token_payload: payload as unknown as Json,
  });

  if (error) {
    // Sanitized, server-side only. `error.message` may embed constraint
    // values (uuids/domains — non-secret); sanitizeForLog additionally
    // redacts anything token-shaped as defense in depth.
    console.error("[shopify persistence] store_connection_tokens failed", {
      projectId,
      shopDomain,
      code: error.code ?? null,
      message: sanitizeForLog(error.message ?? ""),
    });
    throw new ShopifyPersistenceError("store_failed");
  }
}

/**
 * Adapter boundary for the server-only lifecycle state machine.
 *
 * All raw Vault values stay inside this module and the server-only
 * `token-lifecycle` module. None of these helpers are exported as a browser
 * API, and no error below carries a raw Supabase/Shopify response message.
 */
class TokenStoreBoundaryError extends Error {
  constructor() {
    super("Shopify token store boundary failed");
    this.name = "TokenStoreBoundaryError";
  }
}

/**
 * The persisted token-pair columns shared by both trusted RPC projections.
 * Every column here IS declared in the `RETURNS TABLE` of both functions.
 */
type TokenPairRow = {
  connection_id: string;
  project_id: string;
  shop_domain: string;
  status: string;
  access_token: string | null;
  refresh_token: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  credential_version: number;
};

/** `get_connection_tokens_by_id` returns the pair PLUS the lease columns. */
type TokenLifecycleRow = TokenPairRow & {
  refresh_claim_id: string | null;
  refresh_claim_expires_at: string | null;
};

/**
 * `claim_connection_token_refresh` returns ONLY the pair + `claim_result`.
 *
 * Its `RETURNS TABLE` does NOT declare `refresh_claim_id` /
 * `refresh_claim_expires_at`, and PostgREST omits undeclared OUT columns
 * entirely — those keys are ABSENT from the JSON, not null. This type makes
 * that contract explicit: indexing lease fields from a claim row would yield
 * `undefined`, which the previous generic mapper fed into date parsing and
 * misclassified as a store failure — the exact root cause of the 2B.3B-2A
 * production `persistence_failed` (adapter threw AFTER the database lease
 * had been acquired, so the claim was never released).
 */
type ClaimLifecycleRow = TokenPairRow & {
  claim_result: string;
};

/**
 * Strict by design: `null` means the column was declared and empty;
 * `undefined` (an undeclared column) reaching this helper means the SQL
 * contract drifted, and must fail closed rather than silently refresh forever.
 */
function parseExpiry(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TokenStoreBoundaryError();
  return parsed;
}

function validateTokenPair(row: TokenPairRow): void {
  if (
    !Number.isSafeInteger(row.credential_version) ||
    row.credential_version < 1
  ) {
    throw new TokenStoreBoundaryError();
  }
}

function mapTokenPair(row: TokenPairRow): Omit<
  ShopifyTokenRecord,
  "refreshClaimId" | "refreshClaimExpiresAt"
> {
  return {
    connectionId: row.connection_id,
    projectId: row.project_id,
    shopDomain: row.shop_domain,
    status: row.status as ShopifyTokenRecord["status"],
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessTokenExpiresAt: parseExpiry(row.access_token_expires_at),
    refreshTokenExpiresAt: parseExpiry(row.refresh_token_expires_at),
    credentialVersion: row.credential_version,
  };
}

/** Full trusted-read projection (11 columns, including the lease pair). */
function mapTokenRecord(row: TokenLifecycleRow): ShopifyTokenRecord {
  validateTokenPair(row);
  return {
    ...mapTokenPair(row),
    refreshClaimId: row.refresh_claim_id,
    refreshClaimExpiresAt: parseExpiry(row.refresh_claim_expires_at),
  };
}

/**
 * Claim-response projection (10 columns — NO lease pair). The lease fields
 * are recorded as `null` instead of invented: this RPC does not return them,
 * the database is the lease authority, and the lifecycle never reads lease
 * fields from a claim result.
 */
function mapClaimRecord(row: ClaimLifecycleRow): ShopifyTokenRecord {
  validateTokenPair(row);
  return {
    ...mapTokenPair(row),
    refreshClaimId: null,
    refreshClaimExpiresAt: null,
  };
}

/**
 * Builds the real PostgREST-backed token store around a service-role client.
 *
 * EXPORTED FOR SERVER-ONLY TESTS: the module is `import "server-only"`, so a
 * Client Component import remains a BUILD error. Regression tests construct it
 * with a fake Supabase client (contract tests) or a local-stack client
 * (integration tests) so the real RPC parameter names, response projection,
 * and error classification are exercised without touching production or a
 * real Shopify request. `getValidAccessToken` remains the sanctioned
 * production entry point.
 */
export function createShopifyTokenStore(
  supabase: SupabaseClient<Database>,
): ShopifyTokenStore {
  return {
    async get(connectionId) {
      const { data, error } = await supabase.rpc("get_connection_tokens_by_id", {
        p_connection_id: connectionId,
      });
      if (error) throw new TokenStoreBoundaryError();
      const row = data?.[0] as TokenLifecycleRow | undefined;
      return row ? mapTokenRecord(row) : null;
    },

    async claim({ connectionId, claimId, expectedVersion, leaseSeconds }) {
      const { data, error } = await supabase.rpc("claim_connection_token_refresh", {
        p_connection_id: connectionId,
        p_claim_id: claimId,
        p_expected_version: expectedVersion,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new TokenStoreBoundaryError();
      const row = data?.[0] as ClaimLifecycleRow | undefined;
      if (!row) return { result: "not_found" };

      if (row.claim_result === "claimed") {
        return { result: "claimed", record: mapClaimRecord(row) };
      }
      if (
        row.claim_result === "not_found" ||
        row.claim_result === "not_connected" ||
        row.claim_result === "version_conflict" ||
        row.claim_result === "already_claimed" ||
        row.claim_result === "missing_vault"
      ) {
        return { result: row.claim_result } as ShopifyTokenClaimResult;
      }
      throw new TokenStoreBoundaryError();
    },

    async complete({ connectionId, claimId, expectedVersion, payload, reason, apiVersion }) {
      const { data, error } = await supabase.rpc("complete_connection_token_refresh", {
        p_connection_id: connectionId,
        p_claim_id: claimId,
        p_expected_version: expectedVersion,
        p_token_payload: payload as unknown as Json,
        p_reason: reason,
        p_api_version: apiVersion,
      });
      if (error) throw new TokenStoreBoundaryError();
      const result = data?.[0]?.result;
      if (
        result === "completed" ||
        result === "stale" ||
        result === "not_found" ||
        result === "not_connected" ||
        result === "already_reauth_required"
      ) {
        return result;
      }
      throw new TokenStoreBoundaryError();
    },

    async release({ connectionId, claimId }) {
      const { error } = await supabase.rpc("release_connection_token_refresh", {
        p_connection_id: connectionId,
        p_claim_id: claimId,
      });
      if (error) throw new TokenStoreBoundaryError();
    },

    async markReauthRequired({ connectionId, claimId, expectedVersion, reason }) {
      const { data, error } = await supabase.rpc("mark_connection_reauth_required", {
        p_connection_id: connectionId,
        p_claim_id: claimId,
        p_expected_version: expectedVersion,
        p_reason: reason,
      });
      if (error) throw new TokenStoreBoundaryError();
      const result = data?.[0]?.result;
      if (
        result === "completed" ||
        result === "stale" ||
        result === "not_found" ||
        result === "not_connected" ||
        result === "already_reauth_required"
      ) {
        return result;
      }
      throw new TokenStoreBoundaryError();
    },
  };
}

function createShopifyRefreshTransport(): ShopifyRefreshTransport {
  const transport: ShopifyRefreshTransport = {
    async refresh({
      shopDomain,
      refreshToken,
      clientId,
      clientSecret,
    }: {
      shopDomain: string;
      refreshToken: string;
      clientId: string;
      clientSecret: string;
    }): Promise<ShopifyRefreshTransportResult> {
    try {
      const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        return { kind: "http_error", status: response.status };
      }

      try {
        return { kind: "success", body: (await response.json()) as unknown };
      } catch {
        // A 2xx response with invalid JSON is a malformed Shopify response,
        // not a transport failure. Let the lifecycle parser reject it without
        // ever persisting the partial response.
        return { kind: "success", body: null };
      }
    } catch {
      // Do not log the request, response body, or the caught error: fetch
      // errors can contain URLs or upstream diagnostic text.
      return { kind: "network_error" };
    }
    },
  };
  return transport;
}

/**
 * Returns a usable access token to trusted server-side Shopify code only.
 * `connectionId` must come from a server-authorized project lookup; it is
 * never accepted from a browser request or client component. The returned
 * access token is intentionally never routed through a page, client
 * component, API JSON response, or browser boundary.
 */
export async function getValidAccessToken(
  connectionId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<ValidShopifyAccessToken> {
  const env = getShopifyEnv();
  const supabase = getServiceRoleClient();
  if (!env || !supabase) {
    throw new ShopifyTokenLifecycleError("not_configured");
  }

  return getValidAccessTokenWithStore({
    connectionId,
    store: createShopifyTokenStore(supabase),
    transport: createShopifyRefreshTransport(),
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    apiVersion: env.apiVersion,
    forceRefresh: options.forceRefresh ?? false,
    newClaimId: randomUUID,
  });
}

/** Explicit one-attempt refresh path for a trusted caller that needs it. */
export function forceRefreshAccessToken(
  connectionId: string,
): Promise<ValidShopifyAccessToken> {
  return getValidAccessToken(connectionId, { forceRefresh: true });
}

export { ShopifyTokenLifecycleError };
export type { ShopifyRefreshTokenPayload, ValidShopifyAccessToken };
