import "server-only";

import { randomUUID } from "node:crypto";

/**
 * Server-only token lifecycle orchestration.
 *
 * The adapter in `tokens.ts` owns Supabase/Shopify I/O. This module owns the
 * policy and state machine so it can be tested deterministically without a
 * live token, a browser, or a real Shopify request.
 *
 * IMPORTANT POLICY: Shopify currently reports expiring offline access tokens
 * with expires_in normally around 3,600 seconds. StorePilot derives the
 * actual expiry from Shopify's expires_in response. Shopify recommends
 * refreshing shortly before expiry (often a few minutes ahead). StorePilot
 * uses a 60-second proactive safety window before the recorded access-token
 * expiry. That threshold is StorePilot's implementation policy, not a
 * Shopify-mandated constant. A caller can still force one refresh explicitly
 * for an expired/rejected token.
 */

export const SHOPIFY_REFRESH_THRESHOLD_SECONDS = 60;
export const SHOPIFY_REFRESH_LEASE_SECONDS = 60;

export type ShopifyLifecycleStatus =
  | "connected"
  | "reauth_required"
  | "disconnected"
  | "uninstalled";

export interface ShopifyTokenRecord {
  connectionId: string;
  projectId: string;
  shopDomain: string;
  status: ShopifyLifecycleStatus;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  credentialVersion: number;
  refreshClaimId: string | null;
  refreshClaimExpiresAt: Date | null;
}

export interface ShopifyRefreshTokenPayload {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in?: number;
}

export type ShopifyTokenClaimResult =
  | { result: "claimed"; record: ShopifyTokenRecord }
  | {
      result:
        | "not_found"
        | "not_connected"
        | "version_conflict"
        | "already_claimed"
        | "missing_vault";
      record?: ShopifyTokenRecord;
    };

export type ShopifyTokenMutationResult =
  | "completed"
  | "stale"
  | "not_found"
  | "not_connected"
  | "already_reauth_required";

export interface ShopifyTokenStore {
  get(connectionId: string): Promise<ShopifyTokenRecord | null>;
  claim(input: {
    connectionId: string;
    claimId: string;
    expectedVersion: number;
    leaseSeconds: number;
  }): Promise<ShopifyTokenClaimResult>;
  complete(input: {
    connectionId: string;
    claimId: string;
    expectedVersion: number;
    payload: ShopifyRefreshTokenPayload;
    reason: "proactive" | "expired" | "forced";
    apiVersion: string;
  }): Promise<ShopifyTokenMutationResult>;
  release(input: { connectionId: string; claimId: string }): Promise<void>;
  markReauthRequired(input: {
    connectionId: string;
    claimId: string;
    expectedVersion: number;
    reason: "invalid_refresh_token" | "expired_refresh_token" | "revoked_refresh_token" | "missing_refresh_token";
  }): Promise<ShopifyTokenMutationResult>;
}

export type ShopifyRefreshTransportResult =
  | { kind: "success"; body: unknown }
  | { kind: "http_error"; status: number }
  | { kind: "network_error" };

export interface ShopifyRefreshTransport {
  refresh(input: {
    shopDomain: string;
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }): Promise<ShopifyRefreshTransportResult>;
}

export interface ValidShopifyAccessToken {
  connectionId: string;
  shopDomain: string;
  accessToken: string;
  refreshed: boolean;
}

export type ShopifyTokenLifecycleErrorCode =
  | "invalid_connection_id"
  | "not_configured"
  | "not_found"
  | "not_connected"
  | "reauth_required"
  | "invalid_shop_domain"
  | "refresh_in_progress"
  | "stale_refresh"
  | "transient_refresh_failure"
  | "refresh_failed"
  | "invalid_refresh_response"
  | "persistence_failed";

/** A code-only error: never carries a token, response body, or DB message. */
export class ShopifyTokenLifecycleError extends Error {
  readonly code: ShopifyTokenLifecycleErrorCode;
  readonly retryable: boolean;

  constructor(code: ShopifyTokenLifecycleErrorCode, retryable = false) {
    super(`Shopify token lifecycle failed: ${code}`);
    this.name = "ShopifyTokenLifecycleError";
    this.code = code;
    this.retryable = retryable;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

function isValidConnectionId(value: string): boolean {
  return UUID_RE.test(value);
}

function isValidPersistedShopDomain(value: string): boolean {
  return SHOP_DOMAIN_RE.test(value);
}

function isFreshAccessToken(
  record: ShopifyTokenRecord,
  now: Date,
  forceRefresh: boolean,
): boolean {
  if (forceRefresh || !record.accessToken) return false;
  // Shopify's response can omit expires_in for a non-expiring legacy token.
  // Such a token has no known refresh deadline and is safe to reuse.
  if (!record.accessTokenExpiresAt) return true;
  return (
    record.accessTokenExpiresAt.getTime() -
      now.getTime() >
    SHOPIFY_REFRESH_THRESHOLD_SECONDS * 1000
  );
}

function parsePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Strictly validates the successful Shopify refresh response before any
 * persistence call. Extra JSON fields are ignored; required fields are not.
 */
export function parseShopifyRefreshResponse(
  body: unknown,
): ShopifyRefreshTokenPayload {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ShopifyTokenLifecycleError("invalid_refresh_response");
  }

  const value = body as Record<string, unknown>;
  if (
    typeof value.access_token !== "string" ||
    value.access_token.length === 0 ||
    typeof value.refresh_token !== "string" ||
    value.refresh_token.length === 0 ||
    !parsePositiveNumber(value.expires_in)
  ) {
    throw new ShopifyTokenLifecycleError("invalid_refresh_response");
  }

  if (
    value.refresh_token_expires_in !== undefined &&
    !parsePositiveNumber(value.refresh_token_expires_in)
  ) {
    throw new ShopifyTokenLifecycleError("invalid_refresh_response");
  }

  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_in: value.expires_in,
    ...(value.refresh_token_expires_in === undefined
      ? {}
      : { refresh_token_expires_in: value.refresh_token_expires_in }),
  };
}

function isReauthMutationResult(
  result: ShopifyTokenMutationResult,
): boolean {
  return result === "completed" || result === "already_reauth_required";
}

async function releaseQuietly(
  store: ShopifyTokenStore,
  connectionId: string,
  claimId: string,
): Promise<void> {
  try {
    await store.release({ connectionId, claimId });
  } catch {
    // The lease is the durable fallback. A failed cleanup must not mask the
    // original, non-sensitive lifecycle result.
  }
}

function lifecycleErrorForStatus(
  status: ShopifyLifecycleStatus,
): ShopifyTokenLifecycleError {
  return status === "reauth_required"
    ? new ShopifyTokenLifecycleError("reauth_required")
    : new ShopifyTokenLifecycleError("not_connected");
}

function isRetryableClaimFailure(result: ShopifyTokenClaimResult): boolean {
  return (
    result.result === "already_claimed" ||
    result.result === "version_conflict"
  );
}

async function rereadFreshToken(
  store: ShopifyTokenStore,
  connectionId: string,
  now: Date,
  forceRefresh: boolean,
): Promise<ValidShopifyAccessToken | null> {
  const latest = await store.get(connectionId);
  if (!latest || latest.status !== "connected") return null;
  if (!isFreshAccessToken(latest, now, forceRefresh) || !latest.accessToken) {
    return null;
  }
  return {
    connectionId: latest.connectionId,
    shopDomain: latest.shopDomain,
    accessToken: latest.accessToken,
    refreshed: false,
  };
}

/**
 * Gets a usable access token for a trusted server-side Shopify caller.
 *
 * A fresh token is returned without a claim or Shopify request. Otherwise a
 * database lease is claimed before the external request, the response is
 * strictly validated, and completion is guarded by both claim ID and
 * credential version. A stale completion never overwrites a newer token.
 */
export async function getValidAccessTokenWithStore(input: {
  connectionId: string;
  store: ShopifyTokenStore;
  transport: ShopifyRefreshTransport;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  forceRefresh?: boolean;
  now?: () => Date;
  newClaimId?: () => string;
  leaseSeconds?: number;
}): Promise<ValidShopifyAccessToken> {
  const now = input.now ?? (() => new Date());
  const forceRefresh = input.forceRefresh ?? false;
  const newClaimId = input.newClaimId ?? randomUUID;
  const leaseSeconds = input.leaseSeconds ?? SHOPIFY_REFRESH_LEASE_SECONDS;

  if (!isValidConnectionId(input.connectionId)) {
    throw new ShopifyTokenLifecycleError("invalid_connection_id");
  }

  let current: ShopifyTokenRecord | null;
  try {
    current = await input.store.get(input.connectionId);
  } catch {
    throw new ShopifyTokenLifecycleError("persistence_failed", true);
  }

  if (!current) throw new ShopifyTokenLifecycleError("not_found");
  if (current.status !== "connected") throw lifecycleErrorForStatus(current.status);

  const currentTime = now();
  if (isFreshAccessToken(current, currentTime, forceRefresh) && current.accessToken) {
    return {
      connectionId: current.connectionId,
      shopDomain: current.shopDomain,
      accessToken: current.accessToken,
      refreshed: false,
    };
  }

  const claimId = newClaimId();
  let claim: ShopifyTokenClaimResult;
  try {
    claim = await input.store.claim({
      connectionId: input.connectionId,
      claimId,
      expectedVersion: current.credentialVersion,
      leaseSeconds,
    });
  } catch {
    throw new ShopifyTokenLifecycleError("persistence_failed", true);
  }

  if (claim.result !== "claimed") {
    // Another worker may have completed a refresh while this request was
    // reading. Re-read once; never loop or steal another worker's claim.
    if (claim.result === "version_conflict" || claim.result === "already_claimed") {
      try {
        const winner = await rereadFreshToken(
          input.store,
          input.connectionId,
          now(),
          forceRefresh,
        );
        if (winner) return winner;
      } catch {
        throw new ShopifyTokenLifecycleError("persistence_failed", true);
      }
    }
    if (isRetryableClaimFailure(claim)) {
      throw new ShopifyTokenLifecycleError("refresh_in_progress", true);
    }
    if (claim.result === "not_connected") {
      throw claim.record
        ? lifecycleErrorForStatus(claim.record.status)
        : new ShopifyTokenLifecycleError("not_connected");
    }
    if (claim.result === "not_found") {
      throw new ShopifyTokenLifecycleError("not_found");
    }
    throw new ShopifyTokenLifecycleError("persistence_failed", true);
  }

  const claimed = claim.record;
  let claimActive = true;

  try {
    if (claimed.status !== "connected") {
      throw lifecycleErrorForStatus(claimed.status);
    }
    if (!isValidPersistedShopDomain(claimed.shopDomain)) {
      throw new ShopifyTokenLifecycleError("invalid_shop_domain");
    }
    if (!claimed.refreshToken) {
      const reauthResult = await input.store.markReauthRequired({
        connectionId: input.connectionId,
        claimId,
        expectedVersion: claimed.credentialVersion,
        reason: "missing_refresh_token",
      });
      claimActive = false;
      if (isReauthMutationResult(reauthResult)) {
        throw new ShopifyTokenLifecycleError("reauth_required");
      }
      throw new ShopifyTokenLifecycleError("persistence_failed", true);
    }

    const refreshResult = await input.transport.refresh({
      shopDomain: claimed.shopDomain,
      refreshToken: claimed.refreshToken,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    });

    if (refreshResult.kind === "network_error") {
      throw new ShopifyTokenLifecycleError("transient_refresh_failure", true);
    }
    if (refreshResult.kind === "http_error") {
      if (refreshResult.status === 401) {
        const reauthResult = await input.store.markReauthRequired({
          connectionId: input.connectionId,
          claimId,
          expectedVersion: claimed.credentialVersion,
          reason: "invalid_refresh_token",
        });
        claimActive = false;
        if (isReauthMutationResult(reauthResult)) {
          throw new ShopifyTokenLifecycleError("reauth_required");
        }
        throw new ShopifyTokenLifecycleError("persistence_failed", true);
      }
      if (refreshResult.status === 429 || refreshResult.status >= 500) {
        throw new ShopifyTokenLifecycleError("transient_refresh_failure", true);
      }
      throw new ShopifyTokenLifecycleError("refresh_failed");
    }

    const payload = parseShopifyRefreshResponse(refreshResult.body);
    const reason =
      claimed.accessTokenExpiresAt &&
      claimed.accessTokenExpiresAt.getTime() <= now().getTime()
        ? "expired"
        : forceRefresh
          ? "forced"
          : "proactive";

    const completeResult = await input.store.complete({
      connectionId: input.connectionId,
      claimId,
      expectedVersion: claimed.credentialVersion,
      payload,
      reason,
      apiVersion: input.apiVersion,
    });
    claimActive = false;

    if (completeResult === "completed") {
      return {
        connectionId: input.connectionId,
        shopDomain: claimed.shopDomain,
        accessToken: payload.access_token,
        refreshed: true,
      };
    }

    if (completeResult === "stale") {
      const winner = await rereadFreshToken(
        input.store,
        input.connectionId,
        now(),
        forceRefresh,
      );
      if (winner) return winner;
      throw new ShopifyTokenLifecycleError("stale_refresh", true);
    }
    if (completeResult === "not_connected") {
      const latest = await input.store.get(input.connectionId);
      if (latest?.status === "reauth_required") {
        throw new ShopifyTokenLifecycleError("reauth_required");
      }
      throw new ShopifyTokenLifecycleError("not_connected");
    }
    if (completeResult === "not_found") {
      throw new ShopifyTokenLifecycleError("not_found");
    }
    throw new ShopifyTokenLifecycleError("persistence_failed", true);
  } catch (error) {
    if (error instanceof ShopifyTokenLifecycleError) throw error;
    throw new ShopifyTokenLifecycleError("persistence_failed", true);
  } finally {
    if (claimActive) {
      await releaseQuietly(input.store, input.connectionId, claimId);
    }
  }
}
