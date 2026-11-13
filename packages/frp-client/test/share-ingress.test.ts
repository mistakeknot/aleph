import { expect, it, vi } from "vitest";
import {
  generateGateKeyPair,
  importGateKeySet,
  signGateAssertion,
} from "@bb/tunnel-contract/next";
import {
  verifyShareRequest,
  trustedShareKeys,
  shareKeysUrl,
} from "../src/share-ingress.js";

it("selects the configured trust resource verbatim or the trusted account apex", () => {
  vi.stubEnv("BB_CONNECT_GATE_KEYS_URL", "");
  expect(shareKeysUrl("https://account.example.test")).toBe(
    "https://account.example.test/.well-known/bb-connect-gate-keys.json",
  );
  vi.stubEnv(
    "BB_CONNECT_GATE_KEYS_URL",
    "https://keys.example.test/custom.json",
  );
  expect(shareKeysUrl("https://account.example.test")).toBe(
    "https://keys.example.test/custom.json",
  );
  vi.unstubAllEnvs();
});

it("deduplicates and bounds rotation refresh, denies invalid tokens, and recovers from outages", async () => {
  const old = await generateGateKeyPair("old");
  const next = await generateGateKeyPair("next");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ keys: [old.publicKey] }))
    .mockImplementation(async () => Response.json({ keys: [next.publicKey] }));
  const keys = trustedShareKeys("https://keys.example.test/keys.json", fetcher);
  const options = {
    audience: "server:test",
    port: 3000,
    keys,
    registered: () => true,
    nowSeconds: () => 1800000000,
  };
  const sign = (overrides = {}) =>
    signGateAssertion(next.signingKey, {
      audience: "server:test",
      subject: "owner",
      kind: "session",
      method: "GET",
      pathAndQuery: "/",
      target: "3000",
      oauth: null,
      nowSeconds: 1800000000,
      ...overrides,
    });
  const verify = async (token: string) =>
    verifyShareRequest(options, "GET", "/", [["x-bb-gate-assertion", token]]);
  await keys();
  const token = await sign();
  expect(
    await Promise.all(Array.from({ length: 10 }, () => verify(token))),
  ).toEqual(
    Array.from({ length: 10 }, () =>
      expect.objectContaining({ kind: "session" }),
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]).toEqual([
    "https://keys.example.test/keys.json",
    expect.objectContaining({ redirect: "error" }),
  ]);
  for (const overrides of [
    { audience: "server:other" },
    { pathAndQuery: "/other" },
    { target: "4000" },
  ])
    expect(await verify(await sign(overrides))).toBeNull();
  expect(await verify("invalid")).toBeNull();
  const unavailable = {
    ...options,
    keys: async () => {
      throw new Error("offline");
    },
  };
  expect(
    await verifyShareRequest(unavailable, "GET", "/", [
      ["x-bb-gate-assertion", token],
    ]),
  ).toEqual({ kind: "unavailable" });
  for (const overrides of [
    { audience: "server:other" },
    { pathAndQuery: "/other" },
    { target: "4000" },
  ]) {
    expect(
      await verifyShareRequest(unavailable, "GET", "/", [
        ["x-bb-gate-assertion", await sign(overrides)],
      ]),
    ).toBeNull();
  }
  expect(
    await verifyShareRequest(unavailable, "GET", "/", [
      ["x-bb-gate-assertion", "invalid"],
    ]),
  ).toBeNull();
  expect(
    await verifyShareRequest({ ...options, audience: null }, "GET", "/", [
      ["x-bb-gate-assertion", token],
    ]),
  ).toEqual({ kind: "unavailable" });
  expect(await verify(token)).toMatchObject({ kind: "session" });
  const [payload, signature] = token.split(".");
  const forged = `${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
  expect(await verify(forged)).toBeNull();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 61000);
  fetcher.mockRejectedValueOnce(new Error("offline"));
  try {
    expect(await verify(token)).toEqual({ kind: "unavailable" });
    expect(await verify(forged)).toBeNull();
    vi.mocked(Date.now).mockReturnValue(now + 67000);
    expect(await verify(token)).toMatchObject({ kind: "session" });
  } finally {
    vi.restoreAllMocks();
  }
});

it("binds share authority to signature, audience, target, method, query and registration", async () => {
  const pair = await generateGateKeyPair("test");
  const keys = await importGateKeySet({ keys: [pair.publicKey] });
  for (const audience of ["server:test", "machine:test"]) {
    const sign = (overrides = {}) =>
      signGateAssertion(pair.signingKey, {
        audience,
        subject: "owner",
        kind: "session",
        method: "GET",
        pathAndQuery: "/?q=1",
        target: "3000",
        oauth: null,
        nowSeconds: 1800000000,
        ...overrides,
      });
    const verify = (token: string, registered = true) =>
      verifyShareRequest(
        {
          audience,
          port: 3000,
          keys: async () => keys,
          registered: () => registered,
          nowSeconds: () => 1800000000,
        },
        "GET",
        "/?q=1",
        [
          ["x-bb-gate-assertion", token],
          ["x-bb-gate-auth", "session"],
        ],
      );
    expect(await verify(await sign())).toMatchObject({ kind: "session" });
    expect(await verify(await sign({ kind: "public" }))).toMatchObject({
      kind: "public",
    });
    for (const override of [
      { audience: "machine:other" },
      { target: "3001" },
      { method: "POST" },
      { pathAndQuery: "/?q=2" },
      { nowSeconds: 1799999000 },
    ])
      expect(await verify(await sign(override))).toBeNull();
    expect(await verify("forged")).toBeNull();
    expect(await verify(await sign(), false)).toBeNull();
  }
});

it("refuses duplicate assertions and registration lost while keys load", async () => {
  const pair = await generateGateKeyPair("test");
  const keys = await importGateKeySet({ keys: [pair.publicKey] });
  const token = await signGateAssertion(pair.signingKey, {
    audience: "server:test",
    subject: "owner",
    kind: "session",
    method: "GET",
    pathAndQuery: "/",
    target: "3000",
    oauth: null,
    nowSeconds: 1800000000,
  });
  let registered = true;
  const options = {
    audience: "server:test",
    port: 3000,
    registered: () => registered,
    nowSeconds: () => 1800000000,
    keys: async () => {
      registered = false;
      return keys;
    },
  };
  expect(
    await verifyShareRequest(options, "GET", "/", [
      ["x-bb-gate-assertion", token],
    ]),
  ).toBeNull();
  registered = true;
  expect(
    await verifyShareRequest(options, "GET", "/", [
      ["x-bb-gate-assertion", token],
      ["X-Bb-Gate-Assertion", token],
    ]),
  ).toBeNull();
});
