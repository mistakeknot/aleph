import { expect, it } from "vitest";
import {
  generateGateKeyPair,
  importGateKeySet,
  signGateAssertion,
} from "@bb/tunnel-contract/next";
import { verifyShareRequest } from "../src/share-ingress.js";

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
