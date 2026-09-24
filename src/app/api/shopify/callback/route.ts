import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getShopifyEnv } from "@/lib/shopify/env";
import { isValidShopDomain } from "@/lib/shopify/shop";
import { verifyShopifyOAuthCallbackHmac } from "@/lib/shopify/hmac";
import { readOAuthStateCookieValue, stateMatches, STATE_COOKIE_NAME } from "@/lib/shopify/state";
import { ShopifyPersistenceError, storeShopifyTokens } from "@/lib/shopify/tokens";

/**
 * GET /api/shopify/callback
 *
 * Phase 2B.3B-1: turns a successful Shopify authorization round-trip into a
 * DURABLE StorePilot connection. Validation order (unchanged from the 2B.2b
 * spike, every check still fail-closed and uniform in what the browser sees):
 *
 *   1. state cookie valid (HMAC-signed with client secret, 10-min TTL, httpOnly)
 *   2. `state` query == cookie nonce (constant-time)
 *   3. shop domain valid
 *   4. authorization code present
 *   5. Shopify HMAC over the full callback query (constant-time)
 *   6. server-side token exchange (`expiring: "1"` offline-token shape)
 *   7. NEW: durable persistence via store_connection_tokens — Vault secret +
 *      metadata + lifecycle event in ONE transaction (2B.3A primitive)
 *   8. redirect to the Connect step with only a non-sensitive flag
 *
 * TRUSTED PROJECT BINDING (never from the query string): `projectId` comes
 * exclusively from the signed state cookie, which was minted by the authorize
 * route AFTER `requireUser()` + RLS-backed ownership verification. The DB
 * function then re-derives ownership from `sp_projects` and the ownership
 * trigger re-verifies it at write time.
 *
 * TOKEN NON-EXPOSURE: the token pair lives only inside the exchange block
 * below, travels directly into the Vault whitelist inside the DB function,
 * and is never placed in a redirect URL, API response body, log line, or
 * React prop. The callback returns only 302 redirects.
 *
 * NOT in `src/proxy.ts`'s protected-prefix list, deliberately — see the
 * comment in proxy.ts. This handler's own state-cookie + HMAC checks ARE its
 * authentication; a StorePilot login redirect here would break the flow.
 *
 * Rejections are intentionally uniform: every failure path below redirects to
 * the same generic "connection couldn't be verified" style state, never
 * revealing *which* check failed (or any DB/Vault error detail) to the
 * caller — reasons are logged server-side only, with sanitization.
 */
export async function GET(request: NextRequest) {
  const env = getShopifyEnv();
  if (!env) {
    return NextResponse.redirect(errorUrl(request, null, "not_configured"));
  }

  const { searchParams } = request.nextUrl;
  const shop = searchParams.get("shop");
  const callbackState = searchParams.get("state");
  const code = searchParams.get("code");

  const stateCookie = request.cookies.get(STATE_COOKIE_NAME)?.value;
  const statePayload = readOAuthStateCookieValue(stateCookie, env.clientSecret);

  // Every rejection below clears the state cookie so a failed attempt can't
  // be reused, and consumes it on success too (single-use, see state.ts).
  const clearStateCookie = (res: NextResponse) => {
    res.cookies.delete(STATE_COOKIE_NAME);
    return res;
  };

  if (!statePayload) {
    console.error("[shopify callback] rejected: missing/invalid/expired state cookie");
    return clearStateCookie(NextResponse.redirect(errorUrl(request, null, "state_invalid")));
  }

  // Trusted project/user binding — the ONLY source of project identity in
  // this handler. Never re-read from `searchParams`.
  const projectId = statePayload.projectId;

  if (!callbackState || !stateMatches(callbackState, statePayload.nonce)) {
    console.error("[shopify callback] rejected: state mismatch", { projectId });
    return clearStateCookie(NextResponse.redirect(errorUrl(request, projectId, "state_mismatch")));
  }

  if (!shop || !isValidShopDomain(shop)) {
    console.error("[shopify callback] rejected: invalid shop domain", { projectId });
    return clearStateCookie(NextResponse.redirect(errorUrl(request, projectId, "invalid_shop")));
  }

  if (!code) {
    console.error("[shopify callback] rejected: missing code (auth likely denied)", { projectId });
    return clearStateCookie(NextResponse.redirect(errorUrl(request, projectId, "denied")));
  }

  if (!verifyShopifyOAuthCallbackHmac(searchParams, env.clientSecret)) {
    console.error("[shopify callback] rejected: HMAC verification failed", { projectId });
    return clearStateCookie(NextResponse.redirect(errorUrl(request, projectId, "hmac_invalid")));
  }

  // All request-side checks passed. Exchange the code for a token pair and
  // persist it durably. `tokenPayload` is scoped to this handler invocation
  // only; it is nulled out below and never logged, never URL-encoded, never
  // returned in a body.
  let tokenPayload: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    scope?: string;
  } | null = null;

  let tokenMeta: {
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    expiresIn: number | null;
    refreshTokenExpiresIn: number | null;
    grantedScope: string | null;
  };
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.clientId,
        client_secret: env.clientSecret,
        code,
        expiring: "1", // request the 2026 expiring-offline-token shape — see PHASE2B2 §1
      }),
    });

    if (!tokenRes.ok) {
      console.error("[shopify callback] token exchange failed", {
        projectId,
        status: tokenRes.status,
      });
      return clearStateCookie(
        NextResponse.redirect(errorUrl(request, projectId, "token_exchange_failed")),
      );
    }

    const body = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      scope?: string;
    };

    // A. Extract ONLY fields the actual response contained (§7 of the task):
    //    `access_token` is the one required field; every other field is
    //    OPTIONAL and included strictly conditionally — a missing refresh
    //    token is handled explicitly by its absence, never invented.
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      console.error("[shopify callback] token exchange returned no access token", { projectId });
      return clearStateCookie(
        NextResponse.redirect(errorUrl(request, projectId, "token_exchange_failed")),
      );
    }

    tokenPayload = { access_token: body.access_token };
    if (typeof body.refresh_token === "string" && body.refresh_token.length > 0) {
      tokenPayload.refresh_token = body.refresh_token;
    }
    if (typeof body.expires_in === "number") {
      tokenPayload.expires_in = body.expires_in;
    }
    if (typeof body.refresh_token_expires_in === "number") {
      tokenPayload.refresh_token_expires_in = body.refresh_token_expires_in;
    }
    if (typeof body.scope === "string") {
      tokenPayload.scope = body.scope;
    }

    // Metadata only — booleans/numbers for the server log, never the strings.
    tokenMeta = {
      hasAccessToken: true,
      hasRefreshToken: tokenPayload.refresh_token !== undefined,
      expiresIn: tokenPayload.expires_in ?? null,
      refreshTokenExpiresIn: tokenPayload.refresh_token_expires_in ?? null,
      grantedScope: tokenPayload.scope ?? null,
    };
    // `body` goes out of scope here; only the whitelisted `tokenPayload`
    // survives, and it is consumed by the persistence step immediately below.
  } catch (error) {
    console.error("[shopify callback] token exchange threw", { projectId, error });
    return clearStateCookie(
      NextResponse.redirect(errorUrl(request, projectId, "token_exchange_failed")),
    );
  }

  // 7. DURABLE PERSISTENCE — exactly once, only after every check above
  //    succeeded. One SECURITY DEFINER call = one transaction covering Vault
  //    secret, connection metadata (installed/reconnected decided inside),
  //    and the lifecycle event; a throw means NOTHING was written (fail
  //    closed — no partial "connected without tokens" state is possible).
  if (!tokenPayload) {
    // Unreachable by construction; kept as a fail-closed guard so no code
    // path can reach the success redirect without having persisted.
    console.error("[shopify callback] internal: missing token payload", { projectId });
    return clearStateCookie(
      NextResponse.redirect(errorUrl(request, projectId, "token_exchange_failed")),
    );
  }

  try {
    await storeShopifyTokens(projectId, shop, tokenPayload);
  } catch (error) {
    // DB/Vault detail was already logged (sanitized) inside storeShopifyTokens.
    // The BROWSER gets only this generic, non-sensitive reason code — never
    // a Supabase/Vault message, never a constraint name, never token material.
    console.error("[shopify callback] persistence failed", {
      projectId,
      shop,
      reason: error instanceof ShopifyPersistenceError ? error.code : "unknown",
    });
    return clearStateCookie(
      NextResponse.redirect(errorUrl(request, projectId, "persistence_failed")),
    );
  } finally {
    tokenPayload = null; // token strings can no longer be referenced below
  }

  console.info("[shopify callback] connection persisted", {
    projectId,
    shop,
    ...tokenMeta, // booleans/numbers only
  });

  // 8. Success — a NON-SENSITIVE indication that the OAuth attempt returned.
  //    Connected-status display is NEVER derived from this flag: the Connect
  //    page re-reads durable metadata via get_connection_metadata instead.
  const successUrl = request.nextUrl.clone();
  successUrl.pathname = `/projects/${projectId}/wizard/connect`;
  successUrl.search = "";
  successUrl.searchParams.set("shopify_oauth", "ok");
  return clearStateCookie(NextResponse.redirect(successUrl));
}

function errorUrl(request: NextRequest, projectId: string | null, reason: string): URL {
  const url = request.nextUrl.clone();
  url.pathname = projectId ? `/projects/${projectId}/wizard/connect` : "/";
  url.search = "";
  url.searchParams.set("shopify_error", reason);
  return url;
}
