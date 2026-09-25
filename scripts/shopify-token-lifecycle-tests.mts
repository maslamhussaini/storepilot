import assert from "node:assert/strict";
import test from "node:test";

import {
  getValidAccessTokenWithStore,
  parseShopifyRefreshResponse,
  ShopifyTokenLifecycleError,
  type ShopifyRefreshTokenPayload,
  type ShopifyRefreshTransport,
  type ShopifyTokenRecord,
  type ShopifyTokenStore,
} from "../src/lib/shopify/token-lifecycle.ts";
import { createShopifyTokenStore } from "../src/lib/shopify/tokens.ts";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const SHOP_DOMAIN = "fake-refresh-test.myshopify.com";
const NOW = new Date("2026-09-24T12:00:00.000Z");

function plusSeconds(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1000);
}

function makeRecord(overrides: Partial<ShopifyTokenRecord> = {}): ShopifyTokenRecord {
  return {
    connectionId: CONNECTION_ID,
    projectId: PROJECT_ID,
    shopDomain: SHOP_DOMAIN,
    status: "connected",
    accessToken: "fake-access-current",
    refreshToken: "fake-refresh-current",
    accessTokenExpiresAt: plusSeconds(3600),
    refreshTokenExpiresAt: plusSeconds(7 * 24 * 3600),
    credentialVersion: 1,
    refreshClaimId: null,
    refreshClaimExpiresAt: null,
    ...overrides,
  };
}

function copyRecord(record: ShopifyTokenRecord): ShopifyTokenRecord {
  return {
    ...record,
    accessTokenExpiresAt: record.accessTokenExpiresAt
      ? new Date(record.accessTokenExpiresAt.getTime())
      : null,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt
      ? new Date(record.refreshTokenExpiresAt.getTime())
      : null,
    refreshClaimExpiresAt: record.refreshClaimExpiresAt
      ? new Date(record.refreshClaimExpiresAt.getTime())
      : null,
  };
}

interface EventRecord {
  type: string;
  metadata: Record<string, string>;
}

class FakeTokenStore implements ShopifyTokenStore {
  record: ShopifyTokenRecord;
  events: EventRecord[] = [];
  claimCalls = 0;
  completeCalls = 0;
  releaseCalls = 0;
  reauthCalls = 0;
  onComplete: (() => void) | undefined;

  constructor(record: ShopifyTokenRecord = makeRecord()) {
    this.record = copyRecord(record);
  }

  async get(connectionId: string): Promise<ShopifyTokenRecord | null> {
    return connectionId === this.record.connectionId ? copyRecord(this.record) : null;
  }

  async claim(input: {
    connectionId: string;
    claimId: string;
    expectedVersion: number;
    leaseSeconds: number;
  }) {
    this.claimCalls += 1;
    if (input.connectionId !== this.record.connectionId) return { result: "not_found" as const };
    if (this.record.status !== "connected") return { result: "not_connected" as const };
    if (this.record.credentialVersion !== input.expectedVersion) {
      return { result: "version_conflict" as const };
    }
    if (
      this.record.refreshClaimId &&
      this.record.refreshClaimExpiresAt &&
      this.record.refreshClaimExpiresAt > NOW &&
      this.record.refreshClaimId !== input.claimId
    ) {
      return { result: "already_claimed" as const };
    }
    this.record = {
      ...this.record,
      refreshClaimId: input.claimId,
      refreshClaimExpiresAt: new Date(NOW.getTime() + input.leaseSeconds * 1000),
    };
    return { result: "claimed" as const, record: copyRecord(this.record) };
  }

  async complete(input: {
    connectionId: string;
    claimId: string;
    expectedVersion: number;
    payload: ShopifyRefreshTokenPayload;
    reason: "proactive" | "expired" | "forced";
    apiVersion: string;
  }) {
    this.completeCalls += 1;
    this.onComplete?.();
    if (
      input.connectionId !== this.record.connectionId ||
      input.claimId !== this.record.refreshClaimId ||
      input.expectedVersion !== this.record.credentialVersion ||
      this.record.status !== "connected"
    ) {
      return "stale" as const;
    }

    this.record = {
      ...this.record,
      accessToken: input.payload.access_token,
      refreshToken: input.payload.refresh_token,
      accessTokenExpiresAt: plusSeconds(input.payload.expires_in),
      refreshTokenExpiresAt:
        input.payload.refresh_token_expires_in === undefined
          ? this.record.refreshTokenExpiresAt
          : plusSeconds(input.payload.refresh_token_expires_in),
      credentialVersion: this.record.credentialVersion + 1,
      refreshClaimId: null,
      refreshClaimExpiresAt: null,
    };
    this.events.push({
      type: "token_refreshed",
      metadata: { reason: input.reason, api_version: input.apiVersion },
    });
    return "completed" as const;
  }

  async release(input: { connectionId: string; claimId: string }): Promise<void> {
    this.releaseCalls += 1;
    if (
      input.connectionId === this.record.connectionId &&
      input.claimId === this.record.refreshClaimId
    ) {
      this.record = {
        ...this.record,
        refreshClaimId: null,
        refreshClaimExpiresAt: null,
      };
    }
  }

  async markReauthRequired(input: {
    connectionId: string;
    claimId: string;
    expectedVersion: number;
    reason: string;
  }) {
    this.reauthCalls += 1;
    if (input.connectionId !== this.record.connectionId) return "not_found" as const;
    if (this.record.status === "reauth_required") return "already_reauth_required" as const;
    if (this.record.status !== "connected") return "not_connected" as const;
    if (
      input.claimId !== this.record.refreshClaimId ||
      input.expectedVersion !== this.record.credentialVersion
    ) {
      return "stale" as const;
    }

    this.record = {
      ...this.record,
      status: "reauth_required",
      accessToken: null,
      refreshToken: null,
    };
    this.events.push({ type: "reauth_required", metadata: { reason: input.reason } });
    return "completed" as const;
  }
}

function successTransport(
  payload: ShopifyRefreshTokenPayload,
  calls: Array<{ shopDomain: string; refreshToken: string }>,
): ShopifyRefreshTransport {
  return {
    async refresh(input) {
      calls.push({ shopDomain: input.shopDomain, refreshToken: input.refreshToken });
      return { kind: "success", body: payload };
    },
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: ShopifyTokenLifecycleError["code"],
): Promise<void> {
  try {
    await promise;
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.ok(error instanceof ShopifyTokenLifecycleError);
    assert.equal(error.code, code);
  }
}

const refreshedPayload: ShopifyRefreshTokenPayload = {
  access_token: "fake-access-rotated",
  refresh_token: "fake-refresh-rotated",
  expires_in: 3600,
  refresh_token_expires_in: 7 * 24 * 3600,
};

test("A. fresh access token returns without claim or Shopify request", async () => {
  const store = new FakeTokenStore();
  const calls: Array<{ shopDomain: string; refreshToken: string }> = [];
  const result = await getValidAccessTokenWithStore({
    connectionId: CONNECTION_ID,
    store,
    transport: successTransport(refreshedPayload, calls),
    clientId: "fake-client",
    clientSecret: "fake-secret",
    apiVersion: "2026-07",
    now: () => NOW,
    newClaimId: () => "claim-a",
  });
  assert.equal(result.accessToken, "fake-access-current");
  assert.equal(result.refreshed, false);
  assert.equal(store.claimCalls, 0);
  assert.equal(calls.length, 0);
});

test("B. token inside the 60-second threshold refreshes once", async () => {
  const store = new FakeTokenStore(makeRecord({ accessTokenExpiresAt: plusSeconds(59) }));
  const calls: Array<{ shopDomain: string; refreshToken: string }> = [];
  const result = await getValidAccessTokenWithStore({
    connectionId: CONNECTION_ID,
    store,
    transport: successTransport(refreshedPayload, calls),
    clientId: "fake-client",
    clientSecret: "fake-secret",
    apiVersion: "2026-07",
    now: () => NOW,
    newClaimId: () => "claim-b",
  });
  assert.equal(result.accessToken, "fake-access-rotated");
  assert.equal(store.completeCalls, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(store.events[0], {
    type: "token_refreshed",
    metadata: { reason: "proactive", api_version: "2026-07" },
  });
});

test("C. expired access token refreshes", async () => {
  const store = new FakeTokenStore(makeRecord({ accessTokenExpiresAt: plusSeconds(-1) }));
  const calls: Array<{ shopDomain: string; refreshToken: string }> = [];
  const result = await getValidAccessTokenWithStore({
    connectionId: CONNECTION_ID,
    store,
    transport: successTransport(refreshedPayload, calls),
    clientId: "fake-client",
    clientSecret: "fake-secret",
    apiVersion: "2026-07",
    now: () => NOW,
    newClaimId: () => "claim-c",
  });
  assert.equal(result.refreshed, true);
  assert.equal(calls.length, 1);
  assert.equal(store.events[0]?.metadata.reason, "expired");
});

test("D. rotated refresh token becomes authoritative on the next forced refresh", async () => {
  const store = new FakeTokenStore(makeRecord({ accessTokenExpiresAt: plusSeconds(30) }));
  const calls: Array<{ shopDomain: string; refreshToken: string }> = [];
  await getValidAccessTokenWithStore({
    connectionId: CONNECTION_ID,
    store,
    transport: successTransport(refreshedPayload, calls),
    clientId: "fake-client",
    clientSecret: "fake-secret",
    apiVersion: "2026-07",
    now: () => NOW,
    newClaimId: () => "claim-d-1",
  });
  await getValidAccessTokenWithStore({
    connectionId: CONNECTION_ID,
    store,
    transport: successTransport(
      { ...refreshedPayload, access_token: "fake-access-third", refresh_token: "fake-refresh-third" },
      calls,
    ),
    clientId: "fake-client",
    clientSecret: "fake-secret",
    apiVersion: "2026-07",
    forceRefresh: true,
    now: () => NOW,
    newClaimId: () => "claim-d-2",
  });
  assert.equal(calls[0]?.refreshToken, "fake-refresh-current");
  assert.equal(calls[1]?.refreshToken, "fake-refresh-rotated");
  assert.equal(store.record.accessToken, "fake-access-third");
});

test("E. malformed successful response causes no persistence", async () => {
  for (const body of [
    { access_token: "fake-access", expires_in: 3600 },
    { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 0 },
    { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: Number.NaN },
  ]) {
    const store = new FakeTokenStore(makeRecord({ accessTokenExpiresAt: plusSeconds(30) }));
    await expectCode(
      getValidAccessTokenWithStore({
        connectionId: CONNECTION_ID,
        store,
        transport: { refresh: async () => ({ kind: "success", body }) },
        clientId: "fake-client",
        clientSecret: "fake-secret",
        apiVersion: "2026-07",
        now: () => NOW,
        newClaimId: () => "claim-e",
      }),
      "invalid_refresh_response",
    );
    assert.equal(store.completeCalls, 0);
    assert.equal(store.events.length, 0);
    assert.equal(store.record.accessToken, "fake-access-current");
  }
});

test("F. transient network, 429, and 5xx failures do not require reauth", async () => {
  for (const result of [
    { kind: "network_error" as const },
    { kind: "http_error" as const, status: 429 },
    { kind: "http_error" as const, status: 503 },
  ]) {
    const store = new FakeTokenStore(makeRecord({ accessTokenExpiresAt: plusSeconds(30) }));
    await expectCode(
      getValidAccessTokenWithStore({
        connectionId: CONNECTION_ID,
        store,
        transport: { refresh: async () => result },
        clientId: "fake-client",
        clientSecret: "fake-secret",
        apiVersion: "2026-07",
        now: () => NOW,
        newClaimId: () => "claim-f",
      }),
      "transient_refresh_failure",
    );
    assert.equal(store.record.status, "connected");
    assert.equal(store.reauthCalls, 0);
    assert.equal(store.completeCalls, 0);
    assert.equal(store.releaseCalls, 1);
  }
});

test("G. HTTP 401 transitions once to reauth_required", async () => {
  const store = new FakeTokenStore(makeRecord({ accessTokenExpiresAt: plusSeconds(30) }));
  await expectCode(
    getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store,
      transport: { refresh: async () => ({ kind: "http_error", status: 401 }) },
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
      newClaimId: () => "claim-g",
    }),
    "reauth_required",
  );
  assert.equal(store.record.status, "reauth_required");
  assert.equal(store.events.filter((event) => event.type === "reauth_required").length, 1);

  await expectCode(
    getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store,
      transport: { refresh: async () => ({ kind: "http_error", status: 401 }) },
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
      newClaimId: () => "claim-g-2",
    }),
    "reauth_required",
  );
  assert.equal(store.events.filter((event) => event.type === "reauth_required").length, 1);
});

test("H. concurrent callers cannot both complete a rotation", async () => {
  const store = new FakeTokenStore(makeRecord({ accessTokenExpiresAt: plusSeconds(30) }));
  let resolveTransport!: (value: { kind: "success"; body: unknown }) => void;
  const calls: Array<{ shopDomain: string; refreshToken: string }> = [];
  const first = getValidAccessTokenWithStore({
    connectionId: CONNECTION_ID,
    store,
    transport: {
      refresh: async (input) => {
        calls.push({ shopDomain: input.shopDomain, refreshToken: input.refreshToken });
        return new Promise((resolve) => {
          resolveTransport = resolve;
        });
      },
    },
    clientId: "fake-client",
    clientSecret: "fake-secret",
    apiVersion: "2026-07",
    now: () => NOW,
    newClaimId: () => "claim-h-1",
  });
  while (store.claimCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  await expectCode(
    getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store,
      transport: successTransport(refreshedPayload, calls),
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
      newClaimId: () => "claim-h-2",
    }),
    "refresh_in_progress",
  );
  resolveTransport({ kind: "success", body: refreshedPayload });
  const result = await first;
  assert.equal(result.accessToken, "fake-access-rotated");
  assert.equal(store.completeCalls, 1);
  assert.equal(calls.length, 1);
});

test("I. stale completion returns the winner and never exposes the stale response", async () => {
  const store = new FakeTokenStore(makeRecord({ accessTokenExpiresAt: plusSeconds(30) }));
  store.onComplete = () => {
    store.record = {
      ...store.record,
      accessToken: "fake-access-winner",
      accessTokenExpiresAt: plusSeconds(3600),
      credentialVersion: store.record.credentialVersion + 1,
      refreshClaimId: null,
      refreshClaimExpiresAt: null,
    };
  };
  const calls: Array<{ shopDomain: string; refreshToken: string }> = [];
  const result = await getValidAccessTokenWithStore({
    connectionId: CONNECTION_ID,
    store,
    transport: successTransport(refreshedPayload, calls),
    clientId: "fake-client",
    clientSecret: "fake-secret",
    apiVersion: "2026-07",
    now: () => NOW,
    newClaimId: () => "claim-i",
  });
  assert.equal(result.accessToken, "fake-access-winner");
  assert.equal(store.record.accessToken, "fake-access-winner");
  assert.equal(store.events.length, 0);
});

test("J. missing refresh token transitions to reauth without a Shopify request", async () => {
  const store = new FakeTokenStore(
    makeRecord({ accessTokenExpiresAt: plusSeconds(30), refreshToken: null }),
  );
  const calls: Array<{ shopDomain: string; refreshToken: string }> = [];
  await expectCode(
    getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store,
      transport: successTransport(refreshedPayload, calls),
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
      newClaimId: () => "claim-j",
    }),
    "reauth_required",
  );
  assert.equal(calls.length, 0);
  assert.equal(store.events.length, 1);
});

test("K. invalid persisted shop domain fails closed before transport", async () => {
  const store = new FakeTokenStore(
    makeRecord({ accessTokenExpiresAt: plusSeconds(30), shopDomain: "attacker.example" }),
  );
  const calls: Array<{ shopDomain: string; refreshToken: string }> = [];
  await expectCode(
    getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store,
      transport: successTransport(refreshedPayload, calls),
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
      newClaimId: () => "claim-k",
    }),
    "invalid_shop_domain",
  );
  assert.equal(calls.length, 0);
  assert.equal(store.completeCalls, 0);
  assert.equal(store.releaseCalls, 1);
});

test("L. forced refresh is explicit and still uses the guarded path", async () => {
  const store = new FakeTokenStore(makeRecord({ accessTokenExpiresAt: plusSeconds(3600) }));
  const calls: Array<{ shopDomain: string; refreshToken: string }> = [];
  const result = await getValidAccessTokenWithStore({
    connectionId: CONNECTION_ID,
    store,
    transport: successTransport(refreshedPayload, calls),
    clientId: "fake-client",
    clientSecret: "fake-secret",
    apiVersion: "2026-07",
    forceRefresh: true,
    now: () => NOW,
    newClaimId: () => "claim-l",
  });
  assert.equal(result.refreshed, true);
  assert.equal(calls.length, 1);
  assert.equal(store.events[0]?.metadata.reason, "forced");
});

test("N. permanent non-401 HTTP failure does not require reauth", async () => {
  const store = new FakeTokenStore(makeRecord({ accessTokenExpiresAt: plusSeconds(30) }));
  await expectCode(
    getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store,
      transport: { refresh: async () => ({ kind: "http_error", status: 400 }) },
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
      newClaimId: () => "claim-n",
    }),
    "refresh_failed",
  );
  assert.equal(store.record.status, "connected");
  assert.equal(store.reauthCalls, 0);
  assert.equal(store.releaseCalls, 1);
});

test("O. response parser accepts optional refresh expiry and rejects malformed values", () => {
  assert.deepEqual(
    parseShopifyRefreshResponse({
      access_token: "fake-access",
      refresh_token: "fake-refresh",
      expires_in: 3600,
    }),
    { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 },
  );
  assert.throws(
    () =>
      parseShopifyRefreshResponse({
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        expires_in: 3600,
        refresh_token_expires_in: -1,
      }),
    (error: unknown) => error instanceof ShopifyTokenLifecycleError && error.code === "invalid_refresh_response",
  );
});

// ===========================================================================
// Phase 2B.3B-2B — production-shaped adapter contract & claim-cleanup coverage
//
// These tests exercise the REAL server-only adapter (`tokens.ts`) through a
// fake supabase-js client whose responses are shaped exactly like the real
// PostgREST projection of each RPC. Provenance: the claim row below is the
// literal key set captured from the local PostgREST response of
// `claim_connection_token_refresh` (10 keys — the SQL RETURNS TABLE does not
// declare the lease columns, and PostgREST omits undeclared OUT columns).
//
// The 2B.3B-2A production incident: the generic row mapper fed the absent
// `refresh_claim_expires_at` into date parsing as `undefined`, which threw
// a boundary error INSIDE `store.claim()` — after the database lease was
// already acquired — so the lifecycle classified it `persistence_failed`,
// never reached the transport, and never released the claim.
// ===========================================================================

type StoreClient = Parameters<typeof createShopifyTokenStore>[0];

interface RpcCall {
  fn: string;
  params: Record<string, unknown>;
}

/** Scripted fake: rows resolve as data, `error` resolves as an RPC error. */
function fakeClient(
  script: Record<string, { rows: unknown[] } | { error: { message: string } }>,
): { client: StoreClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const client = {
    rpc: async (fn: string, params: Record<string, unknown> = {}) => {
      calls.push({ fn, params });
      const entry = script[fn];
      if (entry === undefined) {
        throw new Error(`fake supabase: unexpected rpc ${fn}`);
      }
      if ("error" in entry) return { data: null, error: entry.error };
      return { data: entry.rows, error: null };
    },
  };
  return { client: client as unknown as StoreClient, calls };
}

/**
 * Exact key set of the production PostgREST response for
 * `claim_connection_token_refresh` — NO `refresh_claim_id` /
 * `refresh_claim_expires_at` keys exist here by contract.
 */
const PRODUCTION_CLAIM_ROW = {
  claim_result: "claimed",
  connection_id: CONNECTION_ID,
  project_id: PROJECT_ID,
  shop_domain: SHOP_DOMAIN,
  status: "connected",
  access_token: "fake-access-current",
  refresh_token: "fake-refresh-current",
  access_token_expires_at: "2026-09-24T11:00:00.000Z",
  refresh_token_expires_at: "2026-10-01T12:00:00.000Z",
  credential_version: 1,
};

/** `get_connection_tokens_by_id` DOES return the lease columns (11 keys). */
const PRODUCTION_GET_ROW = {
  connection_id: CONNECTION_ID,
  project_id: PROJECT_ID,
  shop_domain: SHOP_DOMAIN,
  status: "connected",
  access_token: "fake-access-current",
  refresh_token: "fake-refresh-current",
  access_token_expires_at: "2026-09-24T11:00:00.000Z", // expired vs NOW
  refresh_token_expires_at: "2026-10-01T12:00:00.000Z",
  credential_version: 1,
  refresh_claim_id: null,
  refresh_claim_expires_at: null,
};

function countFn(calls: RpcCall[], fn: string): number {
  return calls.filter((call) => call.fn === fn).length;
}

test("2B-A. production-shaped claim RPC response maps to a claimed record", async () => {
  // Fixture guard: the claim row must never accidentally gain lease keys.
  assert.ok(!("refresh_claim_id" in PRODUCTION_CLAIM_ROW));
  assert.ok(!("refresh_claim_expires_at" in PRODUCTION_CLAIM_ROW));

  const { client, calls } = fakeClient({
    claim_connection_token_refresh: { rows: [PRODUCTION_CLAIM_ROW] },
  });
  const store = createShopifyTokenStore(client);
  const result = await store.claim({
    connectionId: CONNECTION_ID,
    claimId: "claim-2b-a",
    expectedVersion: 1,
    leaseSeconds: 60,
  });
  assert.equal(result.result, "claimed");
  if (result.result !== "claimed") return;
  assert.equal(result.record.credentialVersion, 1);
  assert.equal(result.record.accessToken, "fake-access-current");
  assert.equal(result.record.refreshToken, "fake-refresh-current");
  assert.equal(result.record.accessTokenExpiresAt?.toISOString(), "2026-09-24T11:00:00.000Z");
  // The claim RPC returns no lease columns; the record must not invent them.
  assert.equal(result.record.refreshClaimId, null);
  assert.equal(result.record.refreshClaimExpiresAt, null);
  // Exact production parameter names.
  assert.deepEqual(calls, [
    {
      fn: "claim_connection_token_refresh",
      params: {
        p_connection_id: CONNECTION_ID,
        p_claim_id: "claim-2b-a",
        p_expected_version: 1,
        p_lease_seconds: 60,
      },
    },
  ]);
});

test("2B-A2. production-shaped trusted read response maps every persisted column", async () => {
  const { client } = fakeClient({
    get_connection_tokens_by_id: { rows: [PRODUCTION_GET_ROW] },
  });
  const store = createShopifyTokenStore(client);
  const record = await store.get(CONNECTION_ID);
  assert.ok(record);
  assert.equal(record.credentialVersion, 1);
  assert.equal(record.shopDomain, SHOP_DOMAIN);
  assert.equal(record.accessTokenExpiresAt?.toISOString(), "2026-09-24T11:00:00.000Z");
  assert.equal(record.refreshClaimId, null);
  assert.equal(record.refreshClaimExpiresAt, null);
});

test("2B-B. persistence read success -> claim -> transport once -> complete contract", async () => {
  const { client, calls } = fakeClient({
    get_connection_tokens_by_id: { rows: [PRODUCTION_GET_ROW] },
    claim_connection_token_refresh: { rows: [PRODUCTION_CLAIM_ROW] },
    complete_connection_token_refresh: { rows: [{ result: "completed" }] },
  });
  const transportCalls: string[] = [];
  const result = await getValidAccessTokenWithStore({
    connectionId: CONNECTION_ID,
    store: createShopifyTokenStore(client),
    transport: {
      refresh: async (input) => {
        transportCalls.push(input.refreshToken);
        return { kind: "success", body: refreshedPayload };
      },
    },
    clientId: "fake-client",
    clientSecret: "fake-secret",
    apiVersion: "2026-07",
    now: () => NOW,
    newClaimId: () => "claim-2b-b",
  });
  assert.equal(result.refreshed, true);
  assert.equal(result.accessToken, "fake-access-rotated");
  assert.deepEqual(transportCalls, ["fake-refresh-current"]);
  assert.deepEqual(
    calls.map((call) => call.fn),
    [
      "get_connection_tokens_by_id",
      "claim_connection_token_refresh",
      "complete_connection_token_refresh",
    ],
  );
  const complete = calls[2];
  assert.equal(complete.params.p_connection_id, CONNECTION_ID);
  assert.equal(complete.params.p_claim_id, "claim-2b-b");
  assert.equal(complete.params.p_expected_version, 1);
  assert.equal(complete.params.p_reason, "expired");
  assert.equal(complete.params.p_api_version, "2026-07");
  assert.deepEqual(Object.keys(complete.params.p_token_payload as object), [
    "access_token",
    "refresh_token",
    "expires_in",
    "refresh_token_expires_in",
  ]);
});

test("2B-C. persistence read failure fails closed before any claim or transport", async () => {
  const { client, calls } = fakeClient({
    get_connection_tokens_by_id: { error: { message: "fake database error" } },
  });
  const transportCalls: unknown[] = [];
  await expectCode(
    getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store: createShopifyTokenStore(client),
      transport: {
        refresh: async () => {
          transportCalls.push(1);
          return { kind: "success", body: refreshedPayload };
        },
      },
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
      newClaimId: () => "claim-2b-c",
    }),
    "persistence_failed",
  );
  assert.deepEqual(calls.map((call) => call.fn), ["get_connection_tokens_by_id"]);
  assert.equal(transportCalls.length, 0);
});

test("2B-D. post-lease claim failure explicitly releases THAT claim", async () => {
  // The claim RPC succeeds server-side (lease acquired) but response mapping
  // fails afterwards — credential_version 0 is invalid, so the adapter throws
  // after the lease exists. This is the exact structural shape of the 2B.3B-2A
  // production incident (mapping failure inside store.claim()).
  const brokenClaimRow = { ...PRODUCTION_CLAIM_ROW, credential_version: 0 };
  const { client, calls } = fakeClient({
    get_connection_tokens_by_id: { rows: [PRODUCTION_GET_ROW] },
    claim_connection_token_refresh: { rows: [brokenClaimRow] },
    release_connection_token_refresh: { rows: [{ result: "released" }] },
  });
  const transportCalls: unknown[] = [];
  await expectCode(
    getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store: createShopifyTokenStore(client),
      transport: {
        refresh: async () => {
          transportCalls.push(1);
          return { kind: "success", body: refreshedPayload };
        },
      },
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
      newClaimId: () => "claim-2b-d",
    }),
    "persistence_failed",
  );
  const release = calls.find((call) => call.fn === "release_connection_token_refresh");
  assert.ok(release, "explicit release must be attempted after a post-lease failure");
  assert.deepEqual(release.params, {
    p_connection_id: CONNECTION_ID,
    p_claim_id: "claim-2b-d",
  });
  assert.equal(transportCalls.length, 0);
});

test("2B-E. release after a claim failure is scoped to this attempt's claim id", async () => {
  const { client, calls } = fakeClient({
    get_connection_tokens_by_id: { rows: [PRODUCTION_GET_ROW] },
    claim_connection_token_refresh: { error: { message: "fake claim error" } },
    release_connection_token_refresh: { rows: [{ result: "released" }] },
  });
  await expectCode(
    getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store: createShopifyTokenStore(client),
      transport: { refresh: async () => ({ kind: "success", body: refreshedPayload }) },
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
      newClaimId: () => "claim-2b-e",
    }),
    "persistence_failed",
  );
  const releases = calls.filter((call) => call.fn === "release_connection_token_refresh");
  assert.equal(releases.length, 1, "exactly one release attempt");
  assert.deepEqual(releases[0].params, {
    p_connection_id: CONNECTION_ID,
    p_claim_id: "claim-2b-e",
  });
});

test("2B-F. release failure never masks the original failure classification", async () => {
  const { client, calls } = fakeClient({
    get_connection_tokens_by_id: { rows: [PRODUCTION_GET_ROW] },
    claim_connection_token_refresh: { error: { message: "fake claim error" } },
    release_connection_token_refresh: {
      error: { message: "shpss_fake_secret_from_release_error" },
    },
  });
  const warns: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  try {
    await expectCode(
      getValidAccessTokenWithStore({
        connectionId: CONNECTION_ID,
        store: createShopifyTokenStore(client),
        transport: { refresh: async () => ({ kind: "success", body: refreshedPayload }) },
        clientId: "fake-client",
        clientSecret: "fake-secret",
        apiVersion: "2026-07",
        now: () => NOW,
        newClaimId: () => "claim-2b-f",
      }),
      "persistence_failed",
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(countFn(calls, "release_connection_token_refresh"), 1, "release was attempted");
  // Safe diagnostic metadata only: the upstream error text never reaches logs.
  assert.ok(warns.length >= 1, "a release failure reports safe diagnostics");
  const flat = JSON.stringify(warns);
  assert.ok(!flat.includes("shpss_"), "diagnostics must never contain secret material");
  assert.ok(!flat.includes("fake claim error"), "diagnostics must never echo upstream text");
  assert.ok(flat.includes(CONNECTION_ID) && flat.includes("claim-2b-f"), "diagnostics carry safe ids only");
});

test("2B-G. transport is never invoked after a persistence failure", async () => {
  const brokenClaimRow = { ...PRODUCTION_CLAIM_ROW, credential_version: 0 };
  const { client, calls } = fakeClient({
    get_connection_tokens_by_id: { rows: [PRODUCTION_GET_ROW] },
    claim_connection_token_refresh: { rows: [brokenClaimRow] },
    release_connection_token_refresh: { rows: [{ result: "released" }] },
  });
  let transportCalls = 0;
  await expectCode(
    getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store: createShopifyTokenStore(client),
      transport: {
        refresh: async () => {
          transportCalls += 1;
          return { kind: "success", body: refreshedPayload };
        },
      },
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
      newClaimId: () => "claim-2b-g",
    }),
    "persistence_failed",
  );
  assert.equal(transportCalls, 0);
  assert.equal(countFn(calls, "complete_connection_token_refresh"), 0);
});

test("2B-H. successful fake end-to-end refresh still rotates atomically", async () => {
  const store = new FakeTokenStore(makeRecord({ accessTokenExpiresAt: plusSeconds(-5) }));
  const calls: Array<{ shopDomain: string; refreshToken: string }> = [];
  const result = await getValidAccessTokenWithStore({
    connectionId: CONNECTION_ID,
    store,
    transport: successTransport(refreshedPayload, calls),
    clientId: "fake-client",
    clientSecret: "fake-secret",
    apiVersion: "2026-07",
    now: () => NOW,
    newClaimId: () => "claim-2b-h",
  });
  assert.equal(result.refreshed, true);
  assert.equal(calls.length, 1);
  // Atomic rotation outcomes: generation +1, claim cleared by completion,
  // exactly one event, and no release needed (completion consumed the lease).
  assert.equal(store.record.credentialVersion, 2);
  assert.equal(store.record.refreshClaimId, null);
  assert.equal(store.record.refreshClaimExpiresAt, null);
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].type, "token_refreshed");
  assert.equal(store.releaseCalls, 0);
});

test("2B-I. a stale worker never releases the current worker's claim", async () => {
  const { client, calls } = fakeClient({
    get_connection_tokens_by_id: { rows: [PRODUCTION_GET_ROW] },
    claim_connection_token_refresh: {
      rows: [{ ...PRODUCTION_CLAIM_ROW, claim_result: "already_claimed" }],
    },
  });
  let transportCalls = 0;
  await expectCode(
    getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store: createShopifyTokenStore(client),
      transport: {
        refresh: async () => {
          transportCalls += 1;
          return { kind: "success", body: refreshedPayload };
        },
      },
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
      newClaimId: () => "claim-2b-i",
    }),
    "refresh_in_progress",
  );
  assert.equal(countFn(calls, "release_connection_token_refresh"), 0);
  assert.equal(transportCalls, 0);
});

test("2B-J. failure diagnostics never expose token material", async () => {
  // Adapter boundary: upstream error text is replaced by a fixed message.
  const { client } = fakeClient({
    get_connection_tokens_by_id: { error: { message: "shpss_fake_secret_in_upstream_error" } },
  });
  const adapterStore = createShopifyTokenStore(client);
  await assert.rejects(
    () => adapterStore.get(CONNECTION_ID),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "TokenStoreBoundaryError" &&
      error.message === "Shopify token store boundary failed" &&
      !error.message.includes("shpss_"),
  );

  // Lifecycle: a store throwing secret-bearing text still yields the fixed,
  // code-only error message.
  const secretStore: ShopifyTokenStore = {
    async get() {
      throw new Error("fake-access-supersecret-value");
    },
    async claim() {
      return { result: "not_found" as const };
    },
    async complete() {
      return "stale" as const;
    },
    async release() {
      throw new Error("shpss_fake_secret_release_value");
    },
    async markReauthRequired() {
      return "stale" as const;
    },
  };
  try {
    await getValidAccessTokenWithStore({
      connectionId: CONNECTION_ID,
      store: secretStore,
      transport: { refresh: async () => ({ kind: "success", body: refreshedPayload }) },
      clientId: "fake-client",
      clientSecret: "fake-secret",
      apiVersion: "2026-07",
      now: () => NOW,
    });
    assert.fail("expected persistence_failed");
  } catch (error) {
    assert.ok(error instanceof ShopifyTokenLifecycleError);
    assert.equal(error.code, "persistence_failed");
    assert.equal(error.message, "Shopify token lifecycle failed: persistence_failed");
    assert.ok(!error.message.includes("supersecret"));
    assert.ok(!error.message.includes("shpss_"));
  }
});
