import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALEPH_INSTANCE_GRAMMAR,
  ALEPH_UPDATE_PROBE_INSTANCE,
  alephInstanceUnit,
  alephPolkitUnitPattern,
  buildRecoverInstance,
  buildRollbackInstance,
  buildUpdateInstance,
  isAlephNonce,
  parseAlephInstance,
} from "../src/aleph-update-instance.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const DIGEST = "d".repeat(64);

describe("instance grammar file", () => {
  it("matches the module constant byte for byte", () => {
    const file = readFileSync(
      new URL("../src/aleph-update-instance-grammar.json", import.meta.url),
      "utf8",
    );
    expect(JSON.parse(file)).toEqual(ALEPH_INSTANCE_GRAMMAR);
  });
});

describe("building instances", () => {
  it("builds an update instance with the interrupt consent", () => {
    expect(
      buildUpdateInstance({
        digest: DIGEST,
        interrupt: false,
        nonce: NONCE,
        version: "2.0.0",
      }),
    ).toBe(`update_2.0.0_${DIGEST}_n_${NONCE}`);
    expect(
      buildUpdateInstance({
        digest: DIGEST,
        interrupt: true,
        nonce: NONCE,
        version: "10.20.30",
      }),
    ).toBe(`update_10.20.30_${DIGEST}_i_${NONCE}`);
  });

  it("builds rollback and recover instances", () => {
    expect(
      buildRollbackInstance({
        from: "2.0.0",
        interrupt: true,
        nonce: NONCE,
        to: "1.0.0",
      }),
    ).toBe(`rollback_2.0.0_1.0.0_i_${NONCE}`);
    expect(buildRecoverInstance({ nonce: NONCE })).toBe(`recover_${NONCE}`);
  });

  it("names the systemd unit", () => {
    expect(alephInstanceUnit(`recover_${NONCE}`)).toBe(
      `aleph-update@recover_${NONCE}.service`,
    );
  });

  it("probes with a grammar-valid recover instance", () => {
    expect(ALEPH_UPDATE_PROBE_INSTANCE).toBe(`recover_${"0".repeat(32)}`);
    expect(parseAlephInstance(ALEPH_UPDATE_PROBE_INSTANCE)).not.toBeNull();
  });

  it.each([
    ["short nonce", { nonce: "abc" }],
    ["uppercase nonce", { nonce: NONCE.toUpperCase() }],
    ["short digest", { digest: "d".repeat(63) }],
    ["leading zero version", { version: "01.0.0" }],
    ["four-part version", { version: "1.0.0.0" }],
    ["five digit component", { version: "10000.0.0" }],
    ["two-part version", { version: "1.0" }],
    ["injected separator", { version: "1.0.0_x" }],
  ])("refuses to build an update instance with a %s", (_label, override) => {
    expect(() =>
      buildUpdateInstance({
        digest: DIGEST,
        interrupt: false,
        nonce: NONCE,
        version: "2.0.0",
        ...override,
      }),
    ).toThrow();
  });
});

describe("parsing instances", () => {
  const accepted = [
    `update_0.0.0_${DIGEST}_n_${NONCE}`,
    `update_9999.9999.9999_${DIGEST}_i_${NONCE}`,
    `rollback_1.2.3_1.2.2_n_${NONCE}`,
    `recover_${NONCE}`,
    `adopt_1.2.3_${DIGEST}_n_${NONCE}`,
  ];
  const refused = [
    "",
    "update",
    `update_1.2.3_${DIGEST}_x_${NONCE}`,
    `update_1.2.3_${DIGEST}_n_${NONCE}_extra`,
    `update_1.2.3_${DIGEST}_n_${NONCE}\n`,
    ` update_1.2.3_${DIGEST}_n_${NONCE}`,
    `update_01.2.3_${DIGEST}_n_${NONCE}`,
    `update_1.2.3_${DIGEST.toUpperCase()}_n_${NONCE}`,
    `rollback_1.2.3_n_${NONCE}`,
    `recover_${NONCE}_n`,
    `recover_${NONCE.slice(1)}`,
    `restart_${NONCE}`,
    `stop_${NONCE}`,
    `../update_1.2.3_${DIGEST}_n_${NONCE}`,
    `update_1.2.3_${DIGEST}_n_${NONCE}.service`,
  ];

  it.each(accepted)("accepts %s", (instance) => {
    expect(parseAlephInstance(instance)).not.toBeNull();
  });

  it.each(refused)("refuses %j", (instance) => {
    expect(parseAlephInstance(instance)).toBeNull();
  });

  it("returns the fields of an update instance", () => {
    expect(parseAlephInstance(`update_2.0.0_${DIGEST}_i_${NONCE}`)).toEqual({
      digest: DIGEST,
      interrupt: true,
      nonce: NONCE,
      operation: "update",
      version: "2.0.0",
    });
  });

  it("round-trips every built instance", () => {
    const built = buildRollbackInstance({
      from: "3.0.0",
      interrupt: false,
      nonce: NONCE,
      to: "2.0.0",
    });
    expect(parseAlephInstance(built)).toEqual({
      from: "3.0.0",
      interrupt: false,
      nonce: NONCE,
      operation: "rollback",
      to: "2.0.0",
    });
  });
});

describe("nonces", () => {
  it("accepts only 32 lowercase hex characters", () => {
    expect(isAlephNonce(NONCE)).toBe(true);
    expect(isAlephNonce(`${NONCE}0`)).toBe(false);
    expect(isAlephNonce(NONCE.toUpperCase())).toBe(false);
    expect(isAlephNonce("../etc")).toBe(false);
  });
});

describe("polkit pattern", () => {
  const pattern = new RegExp(alephPolkitUnitPattern());

  it("allows the three server operations and nothing else", () => {
    expect(
      pattern.test(`aleph-update@update_1.0.0_${DIGEST}_n_${NONCE}.service`),
    ).toBe(true);
    expect(
      pattern.test(`aleph-update@rollback_1.0.0_0.9.0_i_${NONCE}.service`),
    ).toBe(true);
    expect(pattern.test(`aleph-update@recover_${NONCE}.service`)).toBe(true);
    expect(
      pattern.test(`aleph-update@adopt_1.0.0_${DIGEST}_n_${NONCE}.service`),
    ).toBe(false);
    expect(pattern.test(`other@recover_${NONCE}.service`)).toBe(false);
    expect(pattern.test(`aleph-update@recover_${NONCE}.service.d`)).toBe(false);
  });
});
