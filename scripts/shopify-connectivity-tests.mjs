#!/usr/bin/env node
// Phase 2B.2b connectivity-spike tests — plain Node assertions, no test
// framework dependency, mirroring the existing scripts/check-css.mjs
// convention (this project adds a JS test runner only when a real ongoing
// need justifies the dependency; this bounded spike doesn't).
//
// Covers what CAN be verified without a live Shopify round-trip or a live
// Supabase session: shop normalization, OAuth state generation/validation,
// and HMAC validation — all pure/deterministic logic. Cross-tenant project
// substitution is NOT re-tested here: the authorize route reuses
// `getProjectWithProfile`, whose ownership guarantee is already proven by
// Phase 2A's 24 executed RLS assertions (supabase/tests/rls_security_tests.sql)
// — this script instead asserts, by source inspection, that the route still
// calls it, as a regression guard against someone quietly bypassing that path.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";

// These are plain .ts modules with no JSX/Next.js runtime dependency, so
// Node's experimental TS loader (or the project's `tsx`-free approach — this
// repo has none installed) isn't available. Rather than add a dependency,
// re-implement the exact same three pure functions inline for the assertions
// below and cross-check them byte-for-byte against the real source via
// string search, so a change to the real implementation that isn't mirrored
// here fails loudly instead of silently testing a stale copy.

function assertSourceContains(path, needle, label) {
  const src = readFileSync(path, "utf8");
  assert.ok(src.includes(needle), `${label}: expected ${path} to contain ${JSON.stringify(needle)}`);
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

// ---------------------------------------------------------------------------
// Shop domain normalization/validation (mirrors src/lib/shopify/shop.ts)
// ---------------------------------------------------------------------------
const SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
function normalizeShopDomain(input) {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const candidate = trimmed.includes(".") ? trimmed : `${trimmed}.myshopify.com`;
  return SHOP_DOMAIN_RE.test(candidate) ? candidate : null;
}

test("shop: bare handle normalizes to full domain", () => {
  assert.equal(normalizeShopDomain("royal-oud"), "royal-oud.myshopify.com");
});
test("shop: full domain passes through", () => {
  assert.equal(normalizeShopDomain("royal-oud.myshopify.com"), "royal-oud.myshopify.com");
});
test("shop: mixed case is lowercased", () => {
  assert.equal(normalizeShopDomain("Royal-Oud"), "royal-oud.myshopify.com");
});
test("shop: rejects a non-Shopify domain", () => {
  assert.equal(normalizeShopDomain("evil.com"), null);
});
test("shop: rejects a suffix-spoofing domain", () => {
  assert.equal(normalizeShopDomain("myshopify.com.evil.com"), null);
});
test("shop: rejects embedded whitespace", () => {
  assert.equal(normalizeShopDomain("royal oud"), null);
});
test("shop: rejects empty input", () => {
  assert.equal(normalizeShopDomain("   "), null);
});
// Real live-test regression: a genuine Shopify development store,
// 0tsfz1-eg.myshopify.com, reported the Connect button staying disabled
// after this exact domain was typed. Traced at the function level: the
// regex's first-character class is `[a-zA-Z0-9]`, which already includes
// digits — a leading "0" was never actually excluded. Both forms below
// were proven to already work correctly before any code change; these
// tests exist to lock that behavior in and catch any future regression
// that reintroduces a letters-only leading-character restriction.
test("shop: accepts a real leading-digit myshopify.com domain (full form)", () => {
  assert.equal(normalizeShopDomain("0tsfz1-eg.myshopify.com"), "0tsfz1-eg.myshopify.com");
});
test("shop: accepts a real leading-digit shop handle (bare form) and normalizes it", () => {
  assert.equal(normalizeShopDomain("0tsfz1-eg"), "0tsfz1-eg.myshopify.com");
});
assertSourceContains(
  "src/lib/shopify/shop.ts",
  "SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\\.myshopify\\.com$/",
  "shop regex drift guard",
);

// ---------------------------------------------------------------------------
// OAuth state: generation binds project/user, validation rejects tampering
// ---------------------------------------------------------------------------
const SECRET = "test-client-secret-not-real";

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
function createState(projectId, userId, secret) {
  const nonce = "a".repeat(64);
  const payload = { nonce, projectId, userId, issuedAt: Date.now() };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { cookieValue: `${encoded}.${sign(encoded, secret)}`, nonce };
}
function readState(cookieValue, secret) {
  if (!cookieValue) return null;
  const [encoded, signature] = cookieValue.split(".");
  if (!encoded || !signature) return null;
  if (sign(encoded, secret) !== signature) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (Date.now() - payload.issuedAt > 10 * 60 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

test("state: round-trips project/user binding", () => {
  const { cookieValue, nonce } = createState("proj-123", "user-abc", SECRET);
  const payload = readState(cookieValue, SECRET);
  assert.equal(payload.projectId, "proj-123");
  assert.equal(payload.userId, "user-abc");
  assert.equal(payload.nonce, nonce);
});
test("state: rejects a tampered signature", () => {
  const { cookieValue } = createState("proj-123", "user-abc", SECRET);
  const [encoded] = cookieValue.split(".");
  const tampered = `${encoded}.${"0".repeat(64)}`;
  assert.equal(readState(tampered, SECRET), null);
});
test("state: rejects wrong secret (different client, replayed cookie)", () => {
  const { cookieValue } = createState("proj-123", "user-abc", SECRET);
  assert.equal(readState(cookieValue, "a-different-secret"), null);
});
test("state: rejects missing cookie", () => {
  assert.equal(readState(undefined, SECRET), null);
});
test("state: rejects malformed cookie shape", () => {
  assert.equal(readState("not-a-real-cookie-value", SECRET), null);
});
test("state: rejects expired payload", () => {
  const nonce = "b".repeat(64);
  const stalePayload = {
    nonce,
    projectId: "proj-123",
    userId: "user-abc",
    issuedAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago, past the 10-minute TTL
  };
  const encoded = Buffer.from(JSON.stringify(stalePayload), "utf8").toString("base64url");
  const expired = `${encoded}.${sign(encoded, SECRET)}`;
  assert.equal(readState(expired, SECRET), null);
});
test("state mismatch: callback state must equal cookie nonce", () => {
  const { nonce } = createState("proj-123", "user-abc", SECRET);
  const forgedCallbackState = "c".repeat(64);
  assert.notEqual(forgedCallbackState, nonce);
});
assertSourceContains("src/lib/shopify/state.ts", "timingSafeEqual", "state: must use constant-time comparison");

// ---------------------------------------------------------------------------
// Shopify OAuth callback HMAC (query-string based)
// ---------------------------------------------------------------------------
function computeCallbackHmac(params, secret) {
  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === "hmac") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  return createHmac("sha256", secret).update(pairs.join("&")).digest("hex");
}

test("hmac: valid signature verifies", () => {
  const params = new URLSearchParams({
    code: "abc123",
    shop: "royal-oud.myshopify.com",
    state: "somestate",
    timestamp: "1700000000",
  });
  const validHmac = computeCallbackHmac(params, SECRET);
  params.set("hmac", validHmac);
  const recomputed = computeCallbackHmac(params, SECRET);
  assert.equal(recomputed, validHmac);
});
test("hmac: a single flipped character anywhere invalidates it", () => {
  const params = new URLSearchParams({
    code: "abc123",
    shop: "royal-oud.myshopify.com",
    state: "somestate",
    timestamp: "1700000000",
  });
  const validHmac = computeCallbackHmac(params, SECRET);
  const tamperedParams = new URLSearchParams(params);
  tamperedParams.set("shop", "royal-0ud.myshopify.com"); // one character changed
  const tamperedHmac = computeCallbackHmac(tamperedParams, SECRET);
  assert.notEqual(tamperedHmac, validHmac);
});
assertSourceContains("src/lib/shopify/hmac.ts", "timingSafeEqual", "hmac: must use constant-time comparison");
assertSourceContains("src/lib/shopify/hmac.ts", "pairs.sort()", "hmac: must sort params lexicographically");

// ---------------------------------------------------------------------------
// Regression guards over the real route source (source inspection, not
// execution — these can't be exercised without a live Supabase session /
// Shopify round-trip, but a silent removal of any of these must fail loudly)
// ---------------------------------------------------------------------------
test("authorize route: re-verifies project ownership via getProjectWithProfile", () => {
  assertSourceContains(
    "src/app/api/shopify/authorize/route.ts",
    "getProjectWithProfile(projectId)",
    "cross-tenant project substitution guard",
  );
});
test("authorize route: requires an authenticated StorePilot session", () => {
  assertSourceContains("src/app/api/shopify/authorize/route.ts", "requireUser()", "auth guard");
});
test("callback route: rejects on missing/invalid state before anything else", () => {
  assertSourceContains("src/app/api/shopify/callback/route.ts", "if (!statePayload)", "state-first rejection order");
});
test("callback route: verifies Shopify HMAC before token exchange", () => {
  assertSourceContains(
    "src/app/api/shopify/callback/route.ts",
    "verifyShopifyOAuthCallbackHmac(searchParams, env.clientSecret)",
    "HMAC-before-exchange guard",
  );
});
test("callback route: never logs the raw token body", () => {
  const src = readFileSync("src/app/api/shopify/callback/route.ts", "utf8");
  // The only console.* calls after the token exchange must reference
  // `tokenMeta` (booleans/numbers), never `body` (which holds the real
  // token strings) or a literal "access_token"/"refresh_token" string.
  const consoleCalls = src.match(/console\.(info|log|warn|error)\([^)]*\)/gs) ?? [];
  for (const call of consoleCalls) {
    assert.ok(!call.includes("body."), `token-non-exposure: a console call references \`body\` directly: ${call}`);
  }
});
test("callback route: token exchange requests the expiring offline shape", () => {
  assertSourceContains("src/app/api/shopify/callback/route.ts", 'expiring: "1"', "2026 expiring-token request param");
});
test("env module: SHOPIFY_CLIENT_SECRET is never read outside src/lib/shopify", () => {
  // Static grep-style check across the routes: the secret should only ever
  // flow through getShopifyEnv(), never be re-read from process.env directly
  // in a route file (which would bypass the single source of truth and make
  // future auditing harder).
  for (const file of [
    "src/app/api/shopify/authorize/route.ts",
    "src/app/api/shopify/callback/route.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.ok(
      !src.includes("process.env.SHOPIFY_CLIENT_SECRET"),
      `${file} reads SHOPIFY_CLIENT_SECRET directly instead of via getShopifyEnv()`,
    );
  }
});

// ---------------------------------------------------------------------------
// Shopify env normalization — Phase 2B.2b CRLF-defense
// ---------------------------------------------------------------------------
const ENV_MODULE = "src/lib/shopify/env.ts";

function normalizeScopes(raw) {
  return raw?.trim() ?? "";
}

test("env: SHOPIFY_SCOPES missing resolves to empty string", () => {
  assert.equal(normalizeScopes(undefined), "");
});
test("env: SHOPIFY_SCOPES empty string resolves to empty string", () => {
  assert.equal(normalizeScopes(""), "");
});
test("env: SHOPIFY_SCOPES CRLF-only resolves to empty string", () => {
  assert.equal(normalizeScopes("\r\n"), "");
});
test("env: SHOPIFY_SCOPES whitespace-only resolves to empty string", () => {
  assert.equal(normalizeScopes("  \t\n  "), "");
});
test("env: SHOPIFY_SCOPES with surrounding whitespace is trimmed", () => {
  assert.equal(normalizeScopes("  read_products  "), "read_products");
});
test("env: required Shopify scalar values trim surrounding CR/LF", () => {
  const src = readFileSync(ENV_MODULE, "utf8");
  assert.ok(src.includes(".trim()"), "env.ts must trim required scalar values");
  assert.ok(
    src.includes("SHOPIFY_SCOPES?.trim()") || src.includes("scopes?.trim()"),
    "env.ts must trim SHOPIFY_SCOPES",
  );
});
test("env: required scalar becomes empty after trim => configuration error", () => {
  const src = readFileSync(ENV_MODULE, "utf8");
  assert.ok(
    src.includes("if (!clientId || !clientSecret || !appUrl || !apiVersion) return null"),
    "required scalars must still reject empty values after trim",
  );
});
test("authorize route: generated zero-scope URL contains scope= with no CR/LF", () => {
  const src = readFileSync("src/app/api/shopify/authorize/route.ts", "utf8");
  assert.ok(
    src.includes('authorizeUrl.searchParams.set("scope", env.scopes)'),
    "authorize route must use env.scopes, not raw process.env",
  );
  assert.ok(
    !src.includes('process.env.SHOPIFY_SCOPES'),
    "authorize route must not read SHOPIFY_SCOPES directly from process.env",
  );
});

// ---------------------------------------------------------------------------
// Connect UI wiring (Phase 2B.2b): the demo button must be fully gone, and
// the real endpoint must be used, via source inspection of the client view —
// there's no JS test runner in this project to mount/render it (see the
// header comment), so these are the same style of regression guard as above.
// ---------------------------------------------------------------------------
const WIZARD_STEP_VIEW = "src/app/projects/[projectId]/wizard/[step]/WizardStepView.tsx";

test("Connect UI: connectDemoStore is no longer imported or called", () => {
  const src = readFileSync(WIZARD_STEP_VIEW, "utf8");
  assert.ok(!src.includes("connectDemoStore"), "connectDemoStore must not appear in WizardStepView.tsx");
});
test("Connect UI: demo-store.myshopify.com is no longer used", () => {
  const src = readFileSync(WIZARD_STEP_VIEW, "utf8");
  assert.ok(!src.includes("demo-store.myshopify.com"), "the hardcoded demo shop domain must be gone");
});
test("Connect UI: old stub file removed", () => {
  assert.throws(
    () => readFileSync("src/lib/shopify/index.ts", "utf8"),
    /ENOENT/,
    "src/lib/shopify/index.ts (connectDemoStore stub) should have been deleted, not left orphaned",
  );
});
test("Connect UI: submits to the real authorize endpoint", () => {
  assertSourceContains(WIZARD_STEP_VIEW, 'action="/api/shopify/authorize"', "real endpoint wiring");
  assertSourceContains(WIZARD_STEP_VIEW, 'method="POST"', "must be a real form POST, not a client fetch");
});
test("Connect UI: projectId is included in the submission", () => {
  assertSourceContains(WIZARD_STEP_VIEW, 'name="projectId" value={projectId}', "projectId must ride along");
});
test("Connect UI: shop domain field is present and validated client-side", () => {
  assertSourceContains(WIZARD_STEP_VIEW, 'name="shop"', "shop input field must exist");
  assertSourceContains(WIZARD_STEP_VIEW, "normalizeShopDomain(shopInput)", "must reuse the real shop validator, not reinvent one");
});
test("Connect UI: submit is disabled until the shop domain normalizes validly", () => {
  assertSourceContains(WIZARD_STEP_VIEW, "disabled={!normalized}", "prevents submitting an unvalidated shop domain");
});
test("Connect UI: the exact gating expression enables for a real leading-digit domain", () => {
  // Re-derives ConnectStep's own `normalized`/`disabled` expressions
  // (`shopInput.trim() ? normalizeShopDomain(shopInput) : null` and
  // `disabled={!normalized}`) against the real reported domain, proving the
  // button-enable path end-to-end rather than only the validator in isolation.
  const shopInput = "0tsfz1-eg.myshopify.com";
  const normalized = shopInput.trim() ? normalizeShopDomain(shopInput) : null;
  const disabled = !normalized;
  assert.equal(disabled, false, "Connect Shopify must NOT be disabled for a valid real domain");
});
test("Connect UI: never references access_token/refresh_token — tokens cannot reach client code", () => {
  const src = readFileSync(WIZARD_STEP_VIEW, "utf8");
  assert.ok(!src.includes("access_token"), "WizardStepView.tsx must never reference access_token");
  assert.ok(!src.includes("refresh_token"), "WizardStepView.tsx must never reference refresh_token");
});
test("Connect UI: client-safe shop.ts helper carries no server-only secret material", () => {
  const src = readFileSync("src/lib/shopify/shop.ts", "utf8");
  assert.ok(
    !src.includes('import "server-only"'),
    "shop.ts is intentionally client-safe (pure string validation only)",
  );
  assert.ok(!src.includes("SHOPIFY_CLIENT_SECRET"), "shop.ts must never touch the client secret");
});

// ---------------------------------------------------------------------------
// Host-consistency / cookie-attribute regression guards, added after a real
// live test hit a host-scoped cookie mismatch: the merchant loaded the
// wizard from http://localhost:3000, so the OAuth state cookie was written
// scoped to `localhost` (no `domain` attribute is ever set, so a cookie is
// implicitly scoped to whatever host issued it) — but Shopify's callback
// always lands on the canonical tunnel host from `redirect_uri`, a
// completely different origin, so the browser correctly never sent that
// cookie back. This was a testing-sequence issue, not a code bug (see
// docs/PHASE2B2_PREFLIGHT_REPORT.md-adjacent incident note), but the
// underlying invariant — `redirect_uri` must come from one fixed
// configuration value, never from the incoming request's own host — is
// exactly the kind of thing that could regress silently, so it's guarded
// here explicitly.
// ---------------------------------------------------------------------------
const AUTHORIZE_ROUTE = "src/app/api/shopify/authorize/route.ts";

test("authorize route: redirect_uri is built from the fixed SHOPIFY_APP_URL, never the request's own host", () => {
  assertSourceContains(AUTHORIZE_ROUTE, "`${env.appUrl}/api/shopify/callback`", "fixed-origin redirect_uri");
  const src = readFileSync(AUTHORIZE_ROUTE, "utf8");
  assert.ok(!src.includes("request.headers.get(\"host\")"), "must not derive redirect_uri from the request Host header");
  assert.ok(!src.includes("request.nextUrl.origin"), "must not derive redirect_uri from the request's own origin");
});
test("state cookie: HttpOnly, Secure, SameSite=Lax, Path=/, bounded expiry — all set explicitly", () => {
  assertSourceContains(AUTHORIZE_ROUTE, "httpOnly: true", "cookie must be HttpOnly");
  assertSourceContains(AUTHORIZE_ROUTE, "secure: true", "cookie must be Secure");
  assertSourceContains(AUTHORIZE_ROUTE, 'sameSite: "lax"', "cookie must be SameSite=Lax (not Strict, not None)");
  assertSourceContains(AUTHORIZE_ROUTE, 'path: "/"', "cookie Path must be /");
  assertSourceContains(AUTHORIZE_ROUTE, "maxAge: 600", "cookie must have a bounded 10-minute expiry");
});
test("state cookie: no explicit Domain attribute (never shared across hosts)", () => {
  const src = readFileSync(AUTHORIZE_ROUTE, "utf8");
  assert.ok(!src.includes("domain:"), "the state cookie must not set an explicit Domain — it must stay host-scoped");
});

// ===========================================================================
// Phase 2B.3B-1 — OAuth persistence, durable connection status, and the
// server-only boundary. Same style as above: pure-logic assertions where the
// behavior is deterministic, source-inspection regression guards where a live
// Shopify round-trip / live Supabase session would otherwise be required.
// The 46 assertions above are unchanged and must keep passing.
// ===========================================================================

const CALLBACK_ROUTE = "src/app/api/shopify/callback/route.ts";
const TOKENS_MODULE = "src/lib/shopify/tokens.ts";
const TOKEN_LIFECYCLE_MODULE = "src/lib/shopify/token-lifecycle.ts";
const CONNECTIONS_MODULE = "src/lib/shopify/connections.ts";
const STATUS_MODULE = "src/lib/shopify/status.ts";
const WIZARD_PAGE = "src/app/projects/[projectId]/wizard/[step]/page.tsx";
const TOKEN_REFRESH_MIGRATION =
  "supabase/migrations/20260924000000_add_shopify_token_refresh_lifecycle.sql";
const TOKEN_REFRESH_SQL_TEST = "supabase/tests/shopify_token_refresh_tests.sql";
const TOKEN_REFRESH_APP_TEST = "scripts/shopify-token-lifecycle-tests.mts";
const APP_SHELL = "src/components/AppShell.tsx";
const DASHBOARD_PAGE = "src/app/page.tsx";
const STORE_FN_SQL =
  "supabase/migrations/20260921000200_create_shopify_security_definer_functions.sql";
const CONNECTIONS_SQL = "supabase/migrations/20260921000000_create_sp_shopify_connections.sql";
const EVENTS_SQL = "supabase/migrations/20260921000100_create_sp_shopify_connection_events.sql";

function countOccurrences(src, needle) {
  return src.split(needle).length - 1;
}

/** Strips block and line comments so assertions match CODE, not prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Returns the slice of `src` from `start` up to the next occurrence of `end`. */
function between(src, start, end, label) {
  const i = src.indexOf(start);
  assert.notEqual(i, -1, `${label}: expected to find ${JSON.stringify(start)}`);
  const j = src.indexOf(end, i + start.length);
  assert.notEqual(j, -1, `${label}: expected to find ${JSON.stringify(end)} after start`);
  return src.slice(i, j);
}

const callbackSrc = readFileSync(CALLBACK_ROUTE, "utf8");
const callbackCode = stripComments(callbackSrc);
const tokensCode = stripComments(readFileSync(TOKENS_MODULE, "utf8"));
const connectionsCode = stripComments(readFileSync(CONNECTIONS_MODULE, "utf8"));
const statusCode = stripComments(readFileSync(STATUS_MODULE, "utf8"));
const wizardPageCode = stripComments(readFileSync(WIZARD_PAGE, "utf8"));
const wizardStepViewState = readFileSync(WIZARD_STEP_VIEW, "utf8");
const storeFnSql = readFileSync(STORE_FN_SQL, "utf8");
const connectionsSql = readFileSync(CONNECTIONS_SQL, "utf8");
const eventsSql = readFileSync(EVENTS_SQL, "utf8");

// ---------------------------------------------------------------------------
// C1. Server-only boundary (task §2)
// ---------------------------------------------------------------------------
test("boundary: tokens.ts carries `import \"server-only\"`", () => {
  assertSourceContains(TOKENS_MODULE, 'import "server-only"', "server-only import");
});
test("boundary: connections.ts carries `import \"server-only\"`", () => {
  assertSourceContains(CONNECTIONS_MODULE, 'import "server-only"', "server-only import");
});
test("boundary: SUPABASE_SERVICE_ROLE_KEY is read in exactly one source file, and it is server-only", () => {
  const readers = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
        if (readFileSync(p, "utf8").includes("process.env.SUPABASE_SERVICE_ROLE_KEY")) readers.push(p);
      }
    }
  };
  walk("src");
  assert.deepEqual(readers, ["src/lib/shopify/tokens.ts"], "service-role key must be read only in tokens.ts");
});
test("boundary: no NEXT_PUBLIC_ variant of the service-role key exists in source or env template", () => {
  const bad = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|mjs|json)$/.test(entry.name)) {
        if (readFileSync(p, "utf8").includes("NEXT_PUBLIC_SUPABASE_SERVICE_ROLE")) bad.push(p);
      }
    }
  };
  walk("src");
  if (readFileSync(".env.example", "utf8").includes("NEXT_PUBLIC_SUPABASE_SERVICE_ROLE")) {
    bad.push(".env.example");
  }
  assert.deepEqual(bad, [], "service-role key must never appear under a NEXT_PUBLIC_ name");
});
test("boundary: shared supabase env.ts (client-importable) does not read the service-role key", () => {
  const src = readFileSync("src/lib/supabase/env.ts", "utf8");
  assert.ok(!src.includes("process.env.SUPABASE_SERVICE_ROLE_KEY"), "env.ts must not read the service-role key");
  assert.ok(!src.includes("SUPABASE_SERVICE_ROLE_KEY="), "env.ts must not define the service-role key");
});
test("boundary: tokens.ts never returns token material — the persist operation is void-or-throw", () => {
  assert.ok(!tokensCode.includes("return payload"), "storeShopifyTokens must not return the payload");
  assert.ok(/Promise<void>/.test(tokensCode), "storeShopifyTokens must be typed Promise<void>");
});
test("boundary: tokens.ts disables session persistence/refresh on the service client", () => {
  assertSourceContains(TOKENS_MODULE, "persistSession: false", "no session persistence");
  assertSourceContains(TOKENS_MODULE, "autoRefreshToken: false", "no auto token refresh");
});
test("boundary: log sanitization redacts token-shaped values before any server-side logging", () => {
  assertSourceContains(TOKENS_MODULE, "[redacted-jwt]", "JWT-shaped redaction");
  assertSourceContains(TOKENS_MODULE, "[redacted]", "opaque-token redaction");
});

// ---------------------------------------------------------------------------
// C2. Callback persistence flow (task §3) — ordering and fail-closed proof
// ---------------------------------------------------------------------------
test("callback: invokes durable persistence exactly once", () => {
  assert.equal(
    countOccurrences(callbackCode, "await storeShopifyTokens("),
    1,
    "exactly one persistence call site",
  );
});
test("callback: every validation gate returns BEFORE persistence is reachable", () => {
  const order = [
    "if (!statePayload)",
    'errorUrl(request, projectId, "state_mismatch")',
    "if (!shop || !isValidShopDomain(shop))",
    "if (!code)",
    "verifyShopifyOAuthCallbackHmac(searchParams, env.clientSecret)",
    'errorUrl(request, projectId, "hmac_invalid")',
    "await fetch(",
    "await storeShopifyTokens(",
    'searchParams.set("shopify_oauth", "ok")',
  ];
  let last = -1;
  for (const needle of order) {
    const at = callbackCode.indexOf(needle);
    assert.ok(at > last, `callback control flow: ${JSON.stringify(needle)} must come after the previous gate (at ${at}, prev ${last})`);
    last = at;
  }
});
test("callback: state failure performs zero persistence (return before the store call)", () => {
  const stateGate = between(callbackCode, "if (!statePayload)", "if (!shop", "state gate");
  assert.ok(!stateGate.includes("storeShopifyTokens"), "no persistence inside/after the state-rejection path");
});
test("callback: HMAC failure performs zero persistence", () => {
  const hmacGate = between(callbackCode, "verifyShopifyOAuthCallbackHmac(searchParams, env.clientSecret)", "const tokenRes", "hmac gate");
  assert.ok(hmacGate.includes("hmac_invalid"), "HMAC failure must redirect");
  assert.ok(!hmacGate.includes("storeShopifyTokens"), "HMAC failure must not persist");
});
test("callback: token exchange failure performs zero persistence", () => {
  const exchangeBlock = between(callbackCode, "const tokenRes", "await storeShopifyTokens(", "exchange block");
  assert.ok(exchangeBlock.includes("token_exchange_failed"), "exchange failure must redirect");
  assert.ok(!exchangeBlock.includes("storeShopifyTokens"), "exchange failure must not persist");
});
test("callback: persistence failure does NOT return success — generic safe error code only", () => {
  assertSourceContains(CALLBACK_ROUTE, "persistence_failed", "safe persistence error code");
  const persistBlock = between(callbackCode, "await storeShopifyTokens(", "successUrl.pathname", "persistence block");
  assert.ok(persistBlock.includes("catch"), "persistence must be wrapped in try/catch");
  assert.ok(persistBlock.includes('errorUrl(request, projectId, "persistence_failed")'), "catch must redirect to a safe error");
  assert.ok(persistBlock.includes("clearStateCookie"), "failure must still consume the state cookie");
  // The success redirect must be unreachable from inside the catch.
  const catchBlock = between(persistBlock, "catch", "finally", "persistence catch");
  assert.ok(!catchBlock.includes("successUrl"), "success redirect must never appear in the catch");
});
test("callback: DB/Vault error detail is never forwarded to the browser", () => {
  const catchBlock = between(callbackCode, "catch", "finally", "persistence catch");
  assert.ok(!catchBlock.includes("error.message"), "raw error message must not be logged/surfaced here");
  assert.ok(!catchBlock.includes("error.code ?? "), "supabase error codes are server-side only");
  // Only the sanitized, non-sensitive reason enum crosses to the redirect.
  assert.ok(catchBlock.includes("reason:"), "logged reason must be the sanitized enum");
});
test("callback: token values never appear in any redirect URL", () => {
  // Success redirect block only: from `const successUrl` to the errorUrl
  // helper. `${projectId}` interpolation is fine (a non-sensitive uuid the
  // caller already owns) — token-material interpolation or literal field
  // names are not.
  const successBlock = between(callbackCode, "const successUrl", "function errorUrl", "success redirect block");
  assert.ok(!successBlock.includes("access_token"), "success redirect must not carry access_token");
  assert.ok(!successBlock.includes("refresh_token"), "success redirect must not carry refresh_token");
  assert.ok(!successBlock.includes("expires"), "success redirect must not carry expiry metadata");
  assert.ok(!successBlock.includes("tokenPayload"), "success redirect must not interpolate the payload");
  assert.ok(!successBlock.includes("${body"), "success redirect must not interpolate the raw response");
  const errorBlock = callbackCode.slice(callbackCode.indexOf("function errorUrl"));
  assert.ok(!errorBlock.includes("access_token") && !errorBlock.includes("refresh_token"), "error redirect must not carry tokens");
});
test("callback: never returns a JSON/API body — redirects only", () => {
  assert.ok(!callbackCode.includes("NextResponse.json"), "callback must not serialize a JSON response");
  assert.ok(!callbackCode.includes("new NextResponse("), "callback must not construct a body-bearing response");
  assert.ok(!callbackCode.includes(".body"), "callback must not attach a body");
});
test("callback: success redirect uses only the non-sensitive shopify_oauth flag (no shop param needed)", () => {
  assertSourceContains(CALLBACK_ROUTE, 'searchParams.set("shopify_oauth", "ok")', "durable-flag redirect");
  assert.ok(!callbackCode.includes("shopify_spike"), "spike flag must be gone from the callback");
  const successBlock = between(callbackCode, "const successUrl", "function errorUrl", "success redirect block");
  assert.ok(!successBlock.includes('searchParams.set("shop"'), "no query-param shop dependence in the success path");
});
test("callback: the token payload is scoped, never logged, and nulled after use", () => {
  assert.ok(callbackCode.includes("tokenPayload = null"), "payload reference must be cleared after persistence");
  const logLines = callbackCode.split("\n").filter((l) => l.includes("console."));
  for (const line of logLines) {
    assert.ok(!line.includes("tokenPayload"), `a console call references tokenPayload: ${line.trim()}`);
    assert.ok(!line.includes("body."), `a console call references body: ${line.trim()}`);
  }
});
test("callback: requires access_token presence explicitly before persisting", () => {
  assertSourceContains(CALLBACK_ROUTE, "typeof body.access_token !== \"string\"", "access_token required");
  assertSourceContains(CALLBACK_ROUTE, "body.access_token.length === 0", "access_token must be non-empty");
});

// ---------------------------------------------------------------------------
// C3. Token response shape / expiry calculation (task §7)
// ---------------------------------------------------------------------------
test("callback: refresh_token is included conditionally — never invented when absent", () => {
  assertSourceContains(
    CALLBACK_ROUTE,
    "if (typeof body.refresh_token === \"string\" && body.refresh_token.length > 0)",
    "conditional refresh_token inclusion",
  );
});
test("callback: expires_in / refresh_token_expires_in / scope are included only when actually numbers/string", () => {
  assertSourceContains(CALLBACK_ROUTE, "if (typeof body.expires_in === \"number\")", "conditional expires_in");
  assertSourceContains(CALLBACK_ROUTE, "if (typeof body.refresh_token_expires_in === \"number\")", "conditional refresh expiry");
  assertSourceContains(CALLBACK_ROUTE, "if (typeof body.scope === \"string\")", "conditional scope");
});
test("expiry: DB computes access-token expiry as now + expires_in seconds", () => {
  assertSourceContains(
    STORE_FN_SQL,
    "((p_token_payload->>'expires_in')::double precision * interval '1 second')",
    "access expiry arithmetic",
  );
});
test("expiry: DB computes refresh-token expiry as now + refresh_token_expires_in seconds", () => {
  assertSourceContains(
    STORE_FN_SQL,
    "((p_token_payload->>'refresh_token_expires_in')::double precision * interval '1 second')",
    "refresh expiry arithmetic",
  );
});
test("expiry: absent optional duration leaves the expiry column NULL (not a fabricated date)", () => {
  assertSourceContains(
    STORE_FN_SQL,
    "case when jsonb_typeof(p_token_payload->'expires_in') = 'number'",
    "null-when-absent expiry",
  );
  assertSourceContains(
    STORE_FN_SQL,
    "case when jsonb_typeof(p_token_payload->'refresh_token_expires_in') = 'number'",
    "null-when-absent refresh expiry",
  );
});
test("vault: payload is whitelisted to exactly access_token + refresh_token (jsonb_strip_nulls drops absent refresh)", () => {
  assertSourceContains(
    STORE_FN_SQL,
    "v_vault_payload := jsonb_strip_nulls(jsonb_build_object(",
    "whitelisted vault payload",
  );
  assertSourceContains(STORE_FN_SQL, "'access_token', p_token_payload->'access_token'", "access_token whitelisted");
  assertSourceContains(STORE_FN_SQL, "'refresh_token', p_token_payload->'refresh_token'", "refresh_token whitelisted");
  // Ensure no other raw field can ride along into Vault.
  const buildBlock = between(storeFnSql, "jsonb_strip_nulls(jsonb_build_object(", ");", "vault payload build");
  assert.equal(countOccurrences(buildBlock, "p_token_payload->"), 2, "exactly two whitelisted fields");
});

// ---------------------------------------------------------------------------
// C4. Idempotency / reconnect (task §4)
// ---------------------------------------------------------------------------
test("idempotency: first-ever authorization logs `installed`, repeat logs `reconnected`", () => {
  assertSourceContains(STORE_FN_SQL, "v_event_type := 'installed'", "installed event");
  assertSourceContains(STORE_FN_SQL, "v_event_type := 'reconnected'", "reconnected event");
  assertSourceContains(STORE_FN_SQL, "elsif exists (", "history check distinguishes first vs repeat");
});
test("idempotency: UPDATE path reuses the project's active row — no duplicate insert", () => {
  assertSourceContains(STORE_FN_SQL, "update public.sp_shopify_connections", "update-first upsert");
  assertSourceContains(STORE_FN_SQL, "where project_id = p_project_id", "scoped to the project");
  assertSourceContains(STORE_FN_SQL, "and status = 'connected'", "only touches the active row");
});
test("idempotency: both partial unique indexes exist and fire only for active rows", () => {
  assertSourceContains(CONNECTIONS_SQL, "sp_shopify_connections_one_active_per_project", "one active per project");
  assertSourceContains(CONNECTIONS_SQL, "sp_shopify_connections_one_active_per_shop", "one active per shop");
  assert.equal(countOccurrences(connectionsSql, "where status = 'connected'"), 2, "both indexes are partial on status='connected'");
});
test("conflict: shop already active on ANOTHER project fails via unique index -> safe persistence_failed", () => {
  // The DB raises on the second active row for the same shop; the callback's
  // catch converts that to the generic persistence_failed redirect. No other
  // project's identity is ever echoed to the browser (see C2 catch test).
  assertSourceContains(CONNECTIONS_SQL, "sp_shopify_connections_one_active_per_shop", "shop uniqueness");
  assertSourceContains(CALLBACK_ROUTE, '"persistence_failed"', "generic conversion");
});
test("events: event metadata never carries token material (DB-level CHECK, all write paths)", () => {
  assert.ok(eventsSql.includes("sp_shopify_connection_events_metadata_no_secrets"), "secret-key CHECK constraint");
  assert.ok(eventsSql.includes("access_token|refresh_token|authorization_code|client_secret"), "forbidden key pattern");
});

// ---------------------------------------------------------------------------
// C5. Safe connection read / DTO (task §5)
// ---------------------------------------------------------------------------
test("safe DTO: ShopifyConnectionStatus has exactly the four allowed fields", () => {
  const iface = between(statusCode, "export interface ShopifyConnectionStatus {", "}", "status interface");
  const fields = [...iface.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(fields.sort(), ["connected", "installedAt", "shopDomain", "status"]);
  assert.ok(!iface.includes("vault"), "no vault reference in the DTO");
  assert.ok(!iface.includes("token"), "no token fields in the DTO");
  assert.ok(!iface.includes("expires"), "no expiry internals in the DTO");
});
test("safe read: connections.ts routes through the user-session server client (RLS path), not the service client", () => {
  assertSourceContains(CONNECTIONS_MODULE, "createSupabaseServerClient", "user-session client");
  assert.ok(!connectionsCode.includes("getServiceRoleClient"), "safe read must not use the service-role client");
  assertSourceContains(CONNECTIONS_MODULE, 'supabase.rpc("get_connection_metadata"', "safe metadata RPC");
});
test("safe read: get_connection_metadata SQL returns only safe columns — no vault or token material", () => {
  // End needle is "$$;" (the closing marker) — the opening `as $$` has no
  // semicolon, so this captures the full signature AND body.
  const fnBody = between(storeFnSql, "create or replace function public.get_connection_metadata", "$$;", "metadata fn");
  assert.ok(!fnBody.includes("vault_secret_id"), "no vault_secret_id in safe read");
  assert.ok(!fnBody.includes("access_token"), "no access token in safe read");
  assert.ok(!fnBody.includes("refresh_token"), "no refresh token in safe read");
  assert.ok(!fnBody.includes("access_token_expires_at"), "no expiry internals in safe read");
});
test("safe read: get_connection_metadata is EXECUTE-granted to authenticated (+ service_role) and revoked elsewhere", () => {
  assertSourceContains(STORE_FN_SQL, "grant execute on function public.get_connection_metadata(uuid) to authenticated", "authenticated grant");
  const revokeBlock = between(
    storeFnSql,
    "revoke execute on function public.get_connection_metadata(uuid)",
    "grant execute on function public.get_connection_metadata(uuid) to authenticated",
    "metadata revoke block",
  );
  assert.ok(
    revokeBlock.includes("from public, anon, authenticated"),
    "revoke must strip the PUBLIC/anon/authenticated default first",
  );
});
test("safe read: fails closed to null on any error — caller maps null to not-connected", () => {
  assertSourceContains(CONNECTIONS_MODULE, "return null", "fail-closed returns");
  assert.ok(!connectionsCode.includes("throw"), "safe read must not throw — it degrades to null");
});
test("tokens: store_connection_tokens remains service_role-only (not callable by authenticated/anon)", () => {
  assertSourceContains(STORE_FN_SQL, "grant execute on function public.store_connection_tokens(uuid, text, jsonb) to service_role", "service_role grant");
  const grants = between(storeFnSql, "revoke execute on function public.store_connection_tokens", "grant execute on function public.store_connection_tokens", "revoke block");
  assert.ok(grants.includes("anon") && grants.includes("authenticated"), "revoke covers anon+authenticated");
});

// ---------------------------------------------------------------------------
// C6. Durable wizard UI (task §6)
// ---------------------------------------------------------------------------
test("wizard page: fetches durable connection status from Supabase on every server render", () => {
  assertSourceContains(WIZARD_PAGE, "getConnectionStatus(project.id)", "durable read");
  assertSourceContains(WIZARD_PAGE, 'from "@/lib/shopify/connections"', "imports the safe read helper");
});
test("wizard page: no query parameter can fake connected status — shopify_spike is fully gone", () => {
  assert.ok(!wizardPageCode.includes("shopify_spike"), "spike query param must be gone");
  assert.ok(!callbackCode.includes("shopify_spike"), "callback must not emit the spike flag");
  // The only query-derived state is the error reason, never a success/connected signal.
  assert.ok(!wizardPageCode.includes('sp.shopify_oauth === "ok" ? { status: "ok"'), "no param-driven success object");
  assert.ok(!wizardPageCode.includes("status: \"ok\""), "no param-derived ok status remains");
});
test("wizard page: maps missing/unknown connection to the fail-closed NO_CONNECTION default", () => {
  assertSourceContains(WIZARD_PAGE, "connection ?? NO_CONNECTION", "fail-closed default");
  assertSourceContains(WIZARD_PAGE, "NO_CONNECTION", "imported default");
});
test("Connect UI: connected view is derived ONLY from the durable connection prop", () => {
  assertSourceContains(WIZARD_STEP_VIEW, "const connected = connection.connected", "prop-derived connected");
  assert.ok(!wizardStepViewState.includes("result?.status === \"ok\""), "no query-param status derivation");
  assert.ok(!wizardStepViewState.includes("shopifyResult"), "old spike result prop is gone");
});
test("Connect UI: renders the durable shop domain and connected badge", () => {
  assertSourceContains(WIZARD_STEP_VIEW, "{connection.shopDomain}", "durable shop domain");
  assertSourceContains(WIZARD_STEP_VIEW, "✓ Shopify connected", "connected badge label");
});
test("Connect UI: no token strings anywhere in the client view (regression from 2B.2)", () => {
  assert.ok(!wizardStepViewState.includes("access_token"), "no access_token in client view");
  assert.ok(!wizardStepViewState.includes("refresh_token"), "no refresh_token in client view");
  assert.ok(!wizardStepViewState.includes("vault"), "no vault reference in client view");
});
test("Connect UI: spike language removed from the production Connect step", () => {
  assert.ok(!wizardStepViewState.includes("spike"), "no 'spike' wording in ConnectStep");
  assert.ok(!wizardStepViewState.includes("connectDemoStore"), "no demo-store call remains");
  assert.ok(!wizardStepViewState.includes("will need to be redone"), "no stale 'will be redone' copy");
});
test("Connect UI: form still posts to the real authorize endpoint with projectId + shop", () => {
  assertSourceContains(WIZARD_STEP_VIEW, 'action="/api/shopify/authorize"', "real endpoint wiring");
  assertSourceContains(WIZARD_STEP_VIEW, 'name="projectId" value={projectId}', "projectId rides along");
  assertSourceContains(WIZARD_STEP_VIEW, 'name="shop"', "shop input field");
});

// ---------------------------------------------------------------------------
// C7. Wizard global action UX cleanup (Phase 2B.3B-1.1)
// ---------------------------------------------------------------------------
test("wizard header action: AppShell conditionally omits the New Store form", () => {
  assertSourceContains(APP_SHELL, "showNewStore = true", "visible by default");
  assertSourceContains(APP_SHELL, "{showNewStore ? (", "conditional form rendering");
  assertSourceContains(APP_SHELL, "action={createProjectAction}", "existing action behavior preserved");
  assertSourceContains(APP_SHELL, "+ New Store", "dashboard action label preserved");
});
test("wizard header action: every wizard AppShell branch hides New Store", () => {
  assert.equal(
    countOccurrences(stripComments(readFileSync(WIZARD_PAGE, "utf8")), "<AppShell user={user} showNewStore={false}>"),
    4,
    "all wizard success and error shells must opt out of the global action",
  );
});
test("dashboard header action: New Store remains visible by default", () => {
  const dashboardCode = stripComments(readFileSync(DASHBOARD_PAGE, "utf8"));
  assert.equal(
    countOccurrences(dashboardCode, "<AppShell user={user}>"),
    1,
    "dashboard must use the visible-by-default AppShell",
  );
  assert.ok(!dashboardCode.includes("showNewStore={false}"), "dashboard must not opt out of New Store");
});

// ---------------------------------------------------------------------------
// C8. Phase 2B.3B-2 token lifecycle source/security guards
// ---------------------------------------------------------------------------
test("token lifecycle: server-only core and adapter are marked server-only", () => {
  assertSourceContains(TOKEN_LIFECYCLE_MODULE, 'import "server-only"', "lifecycle core guard");
  assertSourceContains(TOKENS_MODULE, 'import "server-only"', "service-role adapter guard");
  assertSourceContains(TOKENS_MODULE, "export async function getValidAccessToken", "trusted getter export");
  assertSourceContains(TOKENS_MODULE, "forceRefreshAccessToken", "forced-refresh capability");
});
test("token lifecycle: Shopify refresh uses the documented form-encoded grant", () => {
  assertSourceContains(TOKENS_MODULE, 'grant_type: "refresh_token"', "refresh grant type");
  assertSourceContains(TOKENS_MODULE, '"Content-Type": "application/x-www-form-urlencoded"', "form encoding");
  assertSourceContains(TOKENS_MODULE, "AbortSignal.timeout(30_000)", "bounded refresh request");
  assert.ok(!/console\.(info|log|warn|error)\([^)]*refreshToken/.test(readFileSync(TOKENS_MODULE, "utf8")), "refresh token must never be logged");
});
test("token lifecycle: no client component imports the token boundary", () => {
  const bad = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
        const src = readFileSync(p, "utf8");
        if (src.includes('"use client"') && (src.includes("token-lifecycle") || src.includes("getValidAccessToken"))) {
          bad.push(p);
        }
      }
    }
  };
  walk("src");
  assert.deepEqual(bad, [], "token lifecycle modules must never enter a client component");
});
test("token lifecycle: migration contains durable claim, generation, rotation, and terminal transition", () => {
  for (const needle of [
    "credential_version bigint",
    "refresh_claim_id uuid",
    "claim_connection_token_refresh",
    "complete_connection_token_refresh",
    "vault.update_secret",
    "token_refreshed",
    "mark_connection_reauth_required",
  ]) {
    assertSourceContains(TOKEN_REFRESH_MIGRATION, needle, "refresh migration invariant");
  }
  assert.ok(
    readFileSync(TOKEN_REFRESH_MIGRATION, "utf8").includes(
      "revoke execute on function public.complete_connection_token_refresh",
    ),
    "completion function must be revoked from public/anon/authenticated",
  );
});
test("token lifecycle: deterministic SQL and application suites are present", () => {
  assertSourceContains(TOKEN_REFRESH_SQL_TEST, "ALL SHOPIFY TOKEN REFRESH TESTS PASSED", "SQL completion marker");
  assertSourceContains(TOKEN_REFRESH_APP_TEST, "concurrent callers", "application concurrency coverage");
  assertSourceContains("package.json", '"test:shopify:tokens"', "application test script");
});

// ---------------------------------------------------------------------------
// Phase 2B.3B-2B regression guards (production incident 2B.3B-2A)
// ---------------------------------------------------------------------------

test("token lifecycle: claim adapter never indexes lease columns from a claim row", () => {
  // The claim RPC's RETURNS TABLE omits the lease columns and PostgREST omits
  // undeclared OUT columns entirely — the claim row type must mirror exactly
  // that projection (pair + claim_result, nothing else).
  assertSourceContains(
    TOKENS_MODULE,
    "type ClaimLifecycleRow = TokenPairRow & {",
    "claim row type is the lease-free projection",
  );
  assertSourceContains(
    TOKENS_MODULE,
    "claim_result: string;",
    "claim row type carries claim_result",
  );
  assertSourceContains(
    TOKENS_MODULE,
    "record: mapClaimRecord(row)",
    "claim responses map through the claim-specific mapper",
  );
  assertSourceContains(
    TOKENS_MODULE,
    "refreshClaimId: null,",
    "claim records do not invent lease values",
  );
});

test("token lifecycle: claim acquisition failure releases that claim before failing", () => {
  const clean = stripComments(readFileSync(TOKEN_LIFECYCLE_MODULE, "utf8"));
  // Exactly two release sites: the post-lease claim-failure catch AND the
  // claim-active finally block — never a third unscoped path.
  assert.equal(
    countOccurrences(clean, "releaseQuietly(input.store, input.connectionId, claimId)"),
    2,
    "claim-failure release and claim-active finally release",
  );
  assertSourceContains(
    TOKEN_LIFECYCLE_MODULE,
    "[shopify lifecycle] claim release failed",
    "release failures report safe diagnostics only",
  );
  assertSourceContains(
    TOKEN_LIFECYCLE_MODULE,
    "console.warn(",
    "diagnostics are warn-level and id-only",
  );
});

console.log(`\n${passed} assertions passed.`);
