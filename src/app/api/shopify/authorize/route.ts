import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/dal";
import { getProjectWithProfile } from "@/lib/projects/queries";
import { getShopifyEnv } from "@/lib/shopify/env";
import { normalizeShopDomain } from "@/lib/shopify/shop";
import { createOAuthStateCookieValue, STATE_COOKIE_NAME } from "@/lib/shopify/state";

/**
 * POST /api/shopify/authorize
 *
 * Starts the real Shopify OAuth authorization-code-grant flow (Phase 2B.2b
 * connectivity spike — see docs/PHASE2B1_SHOPIFY_AUTH_PLAN.md §5 for the full
 * route design this implements). A Route Handler, not a Server Action,
 * because it needs to issue a redirect to a different origin (Shopify's
 * authorize endpoint), which Server Actions handle awkwardly.
 *
 * `src/proxy.ts` also protects this path (defense-in-depth, cheap UX win),
 * but `requireUser()` below is the real, mandatory check — same philosophy as
 * every other mutating entry point in this app since Phase 2A.
 */
export async function POST(request: NextRequest) {
  const user = await requireUser();

  const formData = await request.formData();
  const projectId = String(formData.get("projectId") ?? "");
  const shopInput = String(formData.get("shop") ?? "");

  // Ownership check: getProjectWithProfile returns null data for BOTH "no
  // such project" and "someone else's project" (RLS-backed, see Phase 2A),
  // so a tampered projectId degrades to the same generic failure either way —
  // never distinguishing which case it was.
  const result = await getProjectWithProfile(projectId);
  if (result.status !== "ok" || !result.data) {
    return redirectToConnectWithError(request, projectId, "invalid_project");
  }

  const shop = normalizeShopDomain(shopInput);
  if (!shop) {
    return redirectToConnectWithError(request, projectId, "invalid_shop");
  }

  const env = getShopifyEnv();
  if (!env) {
    return redirectToConnectWithError(request, projectId, "not_configured");
  }

  const { cookieValue, nonce } = createOAuthStateCookieValue(projectId, user.id, env.clientSecret);

  const redirectUri = `${env.appUrl}/api/shopify/callback`;
  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", env.clientId);
  // scopes intentionally left as the empty string for this connectivity spike
  // — see docs/PHASE2B2_PREFLIGHT_REPORT.md §2. Not silently defaulted to
  // read_products; the live result is what determines the next step.
  authorizeUrl.searchParams.set("scope", env.scopes);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", nonce);

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(STATE_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    // "lax" (not "strict"): the browser must still send this cookie when
    // Shopify redirects the user BACK to our callback — that is a top-level
    // navigation originating from a different site, which "strict" would
    // drop the cookie for, breaking the whole flow.
    path: "/",
    maxAge: 600, // 10 minutes, matches state.ts's STATE_TTL_MS
  });
  return response;
}

function redirectToConnectWithError(request: NextRequest, projectId: string, reason: string) {
  const url = request.nextUrl.clone();
  url.pathname = projectId
    ? `/projects/${projectId}/wizard/connect`
    : "/";
  url.search = "";
  url.searchParams.set("shopify_error", reason);
  return NextResponse.redirect(url);
}
