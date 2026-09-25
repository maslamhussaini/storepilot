import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import {
  getValidAccessTokenWithStore,
  ShopifyTokenLifecycleError,
  type ShopifyRefreshTransport,
  type ShopifyTokenStore,
} from "../src/lib/shopify/token-lifecycle.ts";
import { createShopifyTokenStore } from "../src/lib/shopify/tokens.ts";

/**
 * Phase 2B.3B-2B — LOCAL integration proofs against the real Supabase stack
 * (PostgREST + Vault + SECURITY DEFINER RPCs) using UNMISTAKABLY FAKE
 * credentials. This suite NEVER contacts Shopify: the refresh transport is a
 * counting fake, and it never runs against production — production was never
 * invoked by this file.
 *
 * Requires the local stack (`supabase start`); the whole suite skips when it
 * is not reachable. Run: npm run test:shopify:tokens:local
 */

const PROJECT_ID = "ab000000-0000-4000-8000-000000000002";
const FIXTURE_SQL = fileURLToPath(
  new URL("../supabase/tests/fixtures_2b_integration_local.sql", import.meta.url),
);

type StoreClient = Parameters<typeof createShopifyTokenStore>[0];

interface LocalEnv {
  apiUrl: string;
  serviceKey: string;
}

function localEnv(): LocalEnv | null {
  try {
    const argv =
      process.platform === "win32"
        ? { cmd: "cmd", args: ["/c", "supabase", "status", "-o", "env"] }
        : { cmd: "supabase", args: ["status", "-o", "env"] };
    const out = execFileSync(argv.cmd, argv.args, { encoding: "utf8", timeout: 60_000 });
    const vars: Record<string, string> = {};
    for (const line of out.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        // Values may be quoted (KEY="value") — normalize without logging.
        vars[line.slice(0, idx).trim()] = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, "$1");
      }
    }
    if (!vars.API_URL || !vars.SERVICE_ROLE_KEY) return null;
    // Local demo credentials — never logged, never printed.
    return { apiUrl: vars.API_URL, serviceKey: vars.SERVICE_ROLE_KEY };
  } catch {
    return null;
  }
}

function psql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_storepilot",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: sql, encoding: "utf8", timeout: 60_000 },
  );
}

function runFixtures(): void {
  psql(readFileSync(FIXTURE_SQL, "utf8"));
}

function connectionId(): string {
  const id = psql(
    `select id from public.sp_shopify_connections where project_id = '${PROJECT_ID}';`,
  ).trim();
  assert.match(id, /^[0-9a-f-]{36}$/i, "fixture connection must exist");
  return id;
}

interface DbState {
  version: number;
  claimId: string;
  refreshedEvents: number;
  reauthEvents: number;
  rotated: boolean;
  reason: string;
}

function readState(): DbState {
  const out = psql(`
    select
      (select credential_version from public.sp_shopify_connections where project_id = '${PROJECT_ID}'),
      (select coalesce(refresh_claim_id::text, '-') from public.sp_shopify_connections where project_id = '${PROJECT_ID}'),
      (select count(*) from public.sp_shopify_connection_events where project_id = '${PROJECT_ID}' and event_type = 'token_refreshed'),
      (select count(*) from public.sp_shopify_connection_events where project_id = '${PROJECT_ID}' and event_type = 'reauth_required'),
      (select access_token = 'fake-access-rotated-local'
         from public.get_connection_tokens_by_id(
           (select id from public.sp_shopify_connections where project_id = '${PROJECT_ID}'))),
      coalesce((select metadata->>'reason'
         from public.sp_shopify_connection_events
         where project_id = '${PROJECT_ID}' and event_type = 'token_refreshed' limit 1), '-');
  `);
  // psql unaligned output separates fields with `|` by default; NULL renders
  // as an empty field.
  const [version, claimId, refreshed, reauth, rotated, reason] = out.trim().split("|");
  return {
    version: Number(version),
    claimId,
    refreshedEvents: Number(refreshed),
    reauthEvents: Number(reauth),
    rotated: rotated === "t",
    reason,
  };
}

async function restRpc(
  env: LocalEnv,
  fn: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${env.apiUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: env.serviceKey,
      Authorization: `Bearer ${env.serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Fixed-shape RPC/PostgREST error text only (no token material is ever
    // part of an error response) — surfaced to make failures diagnosable.
    const body = await response.text();
    throw new Error(`local rest ${fn} failed with status ${response.status}: ${body}`);
  }
  return response.json();
}

function serviceClient(env: LocalEnv): StoreClient {
  return createClient(env.apiUrl, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) as unknown as StoreClient;
}

const fakeTransportPayload = {
  access_token: "fake-access-rotated-local",
  refresh_token: "fake-refresh-rotated-local",
  expires_in: 3600,
  refresh_token_expires_in: 7776000,
};

interface Outcome {
  ok: boolean;
  code: string;
  accessToken?: string;
}

async function runLifecycle(
  store: ShopifyTokenStore,
  transportCalls: string[],
): Promise<Outcome> {
  const transport: ShopifyRefreshTransport = {
    async refresh(input) {
      transportCalls.push(input.refreshToken);
      return { kind: "success", body: fakeTransportPayload };
    },
  };
  try {
    const result = await getValidAccessTokenWithStore({
      connectionId: connectionId(),
      store,
      transport,
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
    });
    return { ok: true, code: "-", accessToken: result.accessToken };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof ShopifyTokenLifecycleError
          ? error.code
          : `unexpected:${error instanceof Error ? error.name : typeof error}`,
    };
  }
}

const env = localEnv();
let stackUp = env !== null;
if (stackUp) {
  try {
    psql("select 1;");
  } catch {
    stackUp = false;
  }
}

const skip = stackUp ? false : "local Supabase stack is not running";

test(
  "2B local integration: real PostgREST/Vault, fake credentials, fake transport",
  { skip },
  async (t) => {
    const local = env as LocalEnv;

    await t.test("claim RPC exposes the production PostgREST column projection", async () => {
      runFixtures();
      const connectionIdValue = connectionId();
      const claimId = "99999999-9999-4999-8999-999999999901";
      const claimResponse = (await restRpc(local, "claim_connection_token_refresh", {
        p_connection_id: connectionIdValue,
        p_claim_id: claimId,
        p_expected_version: 1,
        p_lease_seconds: 60,
      })) as Array<Record<string, unknown>>;

      assert.equal(claimResponse.length, 1);
      const keys = Object.keys(claimResponse[0]).sort();
      // Exactly the SQL RETURNS TABLE columns; the lease columns are absent
      // by contract (this absence was the 2B.3B-2A production root cause).
      assert.deepEqual(keys, [
        "access_token",
        "access_token_expires_at",
        "claim_result",
        "connection_id",
        "credential_version",
        "project_id",
        "refresh_token",
        "refresh_token_expires_at",
        "shop_domain",
        "status",
      ]);
      assert.equal(claimResponse[0].claim_result, "claimed");
      assert.equal(typeof claimResponse[0].credential_version, "number");

      const release = (await restRpc(local, "release_connection_token_refresh", {
        p_connection_id: connectionIdValue,
        p_claim_id: claimId,
      })) as Array<Record<string, unknown>>;
      assert.equal(release[0].result, "released");
    });

    await t.test(
      "expired token -> claim -> transport once -> atomic persistence",
      async () => {
        runFixtures();
        const store = createShopifyTokenStore(serviceClient(local));
        const transportCalls: string[] = [];
        const outcome = await runLifecycle(store, transportCalls);
        const state = readState();

        assert.equal(
          outcome.ok,
          true,
          `lifecycle must succeed; observed classification: ${outcome.code}`,
        );
        assert.equal(outcome.accessToken, "fake-access-rotated-local");
        assert.equal(transportCalls.length, 1, "exactly one fake transport invocation");
        assert.equal(state.version, 2, "credential_version increments exactly once");
        assert.equal(state.claimId, "-", "claim is cleared by completion");
        assert.equal(state.refreshedEvents, 1, "exactly one token_refreshed event");
        assert.equal(state.reauthEvents, 0, "no reauth transition");
        assert.equal(state.rotated, true, "Vault material rotated to the fake token");
        assert.equal(state.reason, "expired", "refresh reason recorded as expired");
      },
    );

    await t.test(
      "post-lease persistence failure -> transport 0, claim released, no rotation",
      async () => {
        runFixtures();
        const realStore = createShopifyTokenStore(serviceClient(local));
        // Simulates the 2B.3B-2A structural failure: the database lease is
        // acquired, then the adapter fails BEFORE transport. The lifecycle
        // must release that exact claim and never touch the transport.
        const failingStore: ShopifyTokenStore = {
          get: (id) => realStore.get(id),
          async claim(input) {
            await realStore.claim(input);
            throw new Error("simulated post-lease adapter failure");
          },
          complete: (input) => realStore.complete(input),
          release: (input) => realStore.release(input),
          markReauthRequired: (input) => realStore.markReauthRequired(input),
        };
        const transportCalls: string[] = [];
        const outcome = await runLifecycle(failingStore, transportCalls);
        const state = readState();

        assert.equal(outcome.code, "persistence_failed");
        assert.equal(transportCalls.length, 0, "transport must never run");
        assert.equal(
          state.claimId,
          "-",
          "the acquired claim must be explicitly released — not left to lease expiry",
        );
        assert.equal(state.version, 1, "credential_version unchanged");
        assert.equal(state.refreshedEvents, 0, "no token_refreshed event");
        assert.equal(state.reauthEvents, 0, "no reauth_required event");
      },
    );

    await t.test(
      "a stale worker cannot release the current worker's claim (service-role REST)",
      async () => {
        runFixtures();
        const connectionIdValue = connectionId();
        const currentClaim = "aaaaaaaa-aaaa-4aaa-8aaa-aaaa00000001";
        const staleClaim = "bbbbbbbb-bbbb-4bbb-8bbb-bbbb00000002";

        const claim = (await restRpc(local, "claim_connection_token_refresh", {
          p_connection_id: connectionIdValue,
          p_claim_id: currentClaim,
          p_expected_version: 1,
          p_lease_seconds: 60,
        })) as Array<Record<string, unknown>>;
        assert.equal(claim[0].claim_result, "claimed");

        const staleRelease = (await restRpc(local, "release_connection_token_refresh", {
          p_connection_id: connectionIdValue,
          p_claim_id: staleClaim,
        })) as Array<Record<string, unknown>>;
        assert.equal(staleRelease[0].result, "not_owner");

        const held = psql(
          `select refresh_claim_id from public.sp_shopify_connections where project_id = '${PROJECT_ID}';`,
        ).trim();
        assert.equal(held, currentClaim, "the current worker's claim remains held");

        const ownerRelease = (await restRpc(local, "release_connection_token_refresh", {
          p_connection_id: connectionIdValue,
          p_claim_id: currentClaim,
        })) as Array<Record<string, unknown>>;
        assert.equal(ownerRelease[0].result, "released");
      },
    );
  },
);
