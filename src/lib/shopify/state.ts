import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OAuth `state` — CSRF/replay protection for the authorization round-trip.
 *
 * The nonce itself is bound to `projectId` + `userId` inside a single signed
 * JSON payload carried in a short-lived, httpOnly, SameSite=Lax cookie — never
 * in sessionStorage/localStorage (client-readable) and never trusted from a
 * query param alone. Binding project/user into the SAME value the callback
 * compares against `state` means a forged callback can't just guess a random
 * nonce; it would also need to forge the cookie, which is httpOnly and
 * unavailable to any script.
 *
 * "Signed" here means HMAC-tagged with the Shopify client secret, reusing the
 * one server secret this app already treats as sensitive rather than
 * introducing a second one. This is a cookie-integrity check (did OUR server
 * issue this value, unmodified), not related to Shopify's own OAuth HMAC
 * verification in `hmac.ts`, which is a separate, later step over different
 * data — the two must not be confused or merged into one helper.
 */

const STATE_COOKIE_NAME = "sp_shopify_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a merchant to approve, short enough to limit replay value.

export interface OAuthStatePayload {
  nonce: string;
  projectId: string;
  userId: string;
  issuedAt: number;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Builds the cookie value: base64url(json) + "." + hmac(json). */
export function createOAuthStateCookieValue(
  projectId: string,
  userId: string,
  clientSecret: string,
): { cookieValue: string; nonce: string } {
  const nonce = randomBytes(32).toString("hex");
  const payload: OAuthStatePayload = { nonce, projectId, userId, issuedAt: Date.now() };
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  const signature = sign(encoded, clientSecret);
  return { cookieValue: `${encoded}.${signature}`, nonce };
}

/**
 * Verifies the cookie's signature and freshness, and returns its payload.
 * Returns `null` on ANY failure (bad shape, bad signature, expired) — callers
 * must treat every failure mode identically (a generic "couldn't verify the
 * connection" response), never distinguishing *why* it failed to the caller.
 */
export function readOAuthStateCookieValue(
  cookieValue: string | undefined,
  clientSecret: string,
): OAuthStatePayload | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  const expectedSignature = sign(encoded, clientSecret);
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expectedSignature, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: OAuthStatePayload;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    payload = JSON.parse(json) as OAuthStatePayload;
  } catch {
    return null;
  }

  if (
    typeof payload.nonce !== "string" ||
    typeof payload.projectId !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.issuedAt !== "number"
  ) {
    return null;
  }

  if (Date.now() - payload.issuedAt > STATE_TTL_MS) return null;

  return payload;
}

/** Constant-time comparison of the callback's `state` param against the cookie's nonce. */
export function stateMatches(callbackState: string, cookieNonce: string): boolean {
  const a = Buffer.from(callbackState, "utf8");
  const b = Buffer.from(cookieNonce, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export { STATE_COOKIE_NAME };
