import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * Next.js 16 renamed the `middleware` file convention to `proxy`
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`
 * — "deprecated in Next.js 16 and renamed to proxy.js"). Functionality is
 * identical; only the file name and exported function name changed. This file
 * is therefore `src/proxy.ts` exporting `proxy`, not `src/middleware.ts`.
 *
 * Two jobs:
 *
 *  1. Refresh the Supabase session. Access tokens are short-lived; Server
 *     Components cannot write cookies, so the rotated token must be written
 *     here or the user would be silently logged out mid-session.
 *
 *  2. Coarse route protection. Unauthenticated visitors are bounced from the
 *     dashboard and wizard to /login before any protected component renders,
 *     so there is no flash of protected content.
 *
 * IMPORTANT — this is a *convenience* layer, not the security boundary. Per the
 * Next.js proxy docs: "Always verify authentication and authorization inside
 * each Server Function rather than relying on Proxy alone." Accordingly every
 * server action and every query in `src/lib/projects/*` independently re-reads
 * the user from the session, and Postgres RLS enforces tenancy underneath both.
 */

/** Routes that require an authenticated user. */
const PROTECTED_PREFIXES = ["/projects", "/api/shopify/authorize"];

/**
 * `/api/shopify/callback` and `/api/shopify/webhooks/*` are DELIBERATELY not
 * listed here, and never should be: the callback's authority comes from
 * StorePilot's own signed OAuth state cookie plus Shopify's HMAC (the user is
 * mid-redirect, not making a fresh authenticated request), and webhooks carry
 * no StorePilot session at all — Shopify's servers call them directly,
 * authenticated only by their own HMAC signature. Routing either through the
 * login redirect would break the flow, not just be redundant. Both routes are
 * unaffected by this proxy today for the same underlying reason `/api/shopify
 * /authorize` needed to be added explicitly: `PROTECTED_PREFIXES` is an
 * allow-list, so anything not named here already passes through untouched.
 */

/** Routes an authenticated user should not see (they get the dashboard instead). */
const AUTH_ROUTES = ["/login", "/signup"];

function isProtectedPath(pathname: string): boolean {
  // The dashboard lives at "/" — match it exactly, not as a prefix.
  if (pathname === "/") return true;
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function proxy(request: NextRequest) {
  const env = getSupabaseEnv();

  // Not configured: do nothing. The app renders a friendly "service
  // unavailable" state rather than redirect-looping on a broken deployment.
  if (!env) return NextResponse.next({ request });

  // This response object is what Supabase writes refreshed auth cookies onto.
  // It must be the object we ultimately return, otherwise the rotated tokens
  // are discarded and the user is logged out on the next request.
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() revalidates the token against the Supabase Auth server. getSession()
  // would only decode whatever the cookie claims, which a client can forge, so it
  // must never be used for an authorization decision.
  let user = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    // Supabase unreachable. Treat as "not authenticated" for redirect purposes
    // but do not hard-fail the request — the page itself renders the outage UI.
    user = null;
  }

  const { pathname } = request.nextUrl;

  if (!user && isProtectedPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.search = "";
    // Preserve where they were headed so login can return them there. Only the
    // path is carried over (never a full URL) to avoid an open-redirect hole.
    if (pathname !== "/") {
      redirectUrl.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(redirectUrl);
  }

  if (user && AUTH_ROUTES.includes(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Run on every path except Next.js internals and static assets. Without an
     * exclusion here the auth redirect would also intercept CSS/JS/image
     * requests and break page rendering.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
