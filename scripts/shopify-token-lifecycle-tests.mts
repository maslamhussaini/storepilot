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
