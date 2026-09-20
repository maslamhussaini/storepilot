import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getShopifyEnv } from "@/lib/shopify/env";
import { isValidShopDomain } from "@/lib/shopify/shop";
import { verifyShopifyOAuthCallbackHmac } from "@/lib/shopify/hmac";
import { readOAuthStateCookieValue, stateMatches, STATE_COOKIE_NAME } from "@/lib/shopify/state";

/**
 * GET /api/shopify/callback
 *
 * Phase 2B.2b connectivity spike ONLY: proves the real authorization
 * round-trip end-to-end (state, HMAC, shop, token exchange), then DISCARDS
 * the returned token pair and redirects back into the wizard with a
 * non-sensitive indicator. No persistence, no Vault, no Supabase writes here
 * — that is Phase 2B.3, once the full `sp_shopify_connections` + Vault design
 * (docs/PHASE2B2_PREFLIGHT_REPORT.md §4/§6) is actually implemented.
 *
 * NOT in `src/proxy.ts`'s protected-prefix list, deliberately — see the
 * comment in proxy.ts. This handler's own state-cookie + HMAC checks ARE its
 * authentication; a StorePilot login redirect here would break the flow.
 *
 * Rejections are intentionally uniform: every failure path below redirects to
 * the same generic "connection couldn't be verified" state, never revealing
 * *which* check failed to the caller (state/HMAC/shop are logged server-side
 * for operator visibility, never surfaced to the client).
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

  // All checks passed. Exchange the code for a token pair — this is the
  // spike's actual proof of a real round-trip. The result is inspected only
  // for non-secret metadata (§5 of the task) and then discarded; nothing is
  // persisted, logged, or returned to the client in this phase.
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

    // Metadata only — never the token strings themselves, not even in a
    // variable that outlives this block, and never logged.
    tokenMeta = {
      hasAccessToken: typeof body.access_token === "string" && body.access_token.length > 0,
      hasRefreshToken: typeof body.refresh_token === "string" && body.refresh_token.length > 0,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
      refreshTokenExpiresIn:
        typeof body.refresh_token_expires_in === "number" ? body.refresh_token_expires_in : null,
      grantedScope: typeof body.scope === "string" ? body.scope : null,
    };
    // `body` (and therefore the real token values) goes out of scope here and
    // is never referenced again — deliberate, not merely incidental.
  } catch (error) {
    console.error("[shopify callback] token exchange threw", { projectId, error });
    return clearStateCookie(
      NextResponse.redirect(errorUrl(request, projectId, "token_exchange_failed")),
    );
  }

  console.info("[shopify callback] spike round-trip verified (token discarded)", {
    projectId,
    shop,
    ...tokenMeta,
  });

  const successUrl = request.nextUrl.clone();
  successUrl.pathname = `/projects/${projectId}/wizard/connect`;
  successUrl.search = "";
  successUrl.searchParams.set("shopify_spike", "ok");
  successUrl.searchParams.set("shop", shop); // non-sensitive — the domain only, never a token
  return clearStateCookie(NextResponse.redirect(successUrl));
}

function errorUrl(request: NextRequest, projectId: string | null, reason: string): URL {
  const url = request.nextUrl.clone();
  url.pathname = projectId ? `/projects/${projectId}/wizard/connect` : "/";
  url.search = "";
  url.searchParams.set("shopify_error", reason);
  return url;
}
