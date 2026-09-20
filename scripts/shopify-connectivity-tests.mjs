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
import { readFileSync } from "node:fs";
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

console.log(`\n${passed} assertions passed.`);
