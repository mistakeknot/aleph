import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeDerivedSha256,
  computeMirrorChecksum,
  effectivePolicy,
  formatAlephUpdateStatePath,
  formatUserDataUpdateStatePath,
  failClosedPolicyVerifier,
  loadEffectivePolicy,
  pluginPolicyDisabledDetail,
  type DerivedPolicy,
  type PolicyCopy,
  type PolicyVerifier,
} from "../src/effective-policy.js";

function derived(overrides: Partial<DerivedPolicy> = {}): DerivedPolicy {
  return {
    disabled_features: [],
    floor_seq: 1,
    install_state: "idle",
    notice: null,
    release: null,
    revoked_key_ids: [],
    skip_versions: [],
    ...overrides,
  };
}

function copy(
  epoch: number,
  policy: DerivedPolicy,
  overrides: Partial<PolicyCopy> = {},
): PolicyCopy {
  return {
    derived: policy,
    epoch,
    head_bytes: `head-${epoch}`,
    semantic_sha256: `sem-${epoch}`,
    sig_bytes: `sig-${epoch}`,
    signing_key_id: "key-a",
    ...overrides,
  };
}

const verifier: PolicyVerifier = {
  derive(copyToDerive) {
    return copyToDerive.head_bytes.startsWith("head-")
      ? (headPolicies.get(copyToDerive.head_bytes) ?? null)
      : null;
  },
  verify(copyToVerify) {
    return copyToVerify.sig_bytes === `sig-${copyToVerify.epoch}`;
  },
};

const headPolicies = new Map<string, DerivedPolicy>();

beforeEach(() => {
  headPolicies.clear();
});

function register(epoch: number, policy: DerivedPolicy): void {
  headPolicies.set(`head-${epoch}`, policy);
}

describe("effectivePolicy", () => {
  it("is uninitialized with empty policy when no copy exists", () => {
    const result = effectivePolicy({
      copies: { db: null, home: null, userData: null },
      verifier,
    });
    expect(result.status).toBe("uninitialized");
    expect(result.failClosed).toBe(false);
    expect(result.disabled_features).toEqual([]);
  });

  it("returns the head-derived policy when all copies agree", () => {
    const policy = derived({ disabled_features: ["a"], floor_seq: 3 });
    register(3, policy);
    const c = copy(3, policy);
    const result = effectivePolicy({
      copies: { db: c, home: c, userData: c },
      verifier,
    });
    expect(result.status).toBe("consistent");
    expect(result.failClosed).toBe(false);
    expect(result.disabled_features).toEqual(["a"]);
    expect(result.authoritative?.epoch).toBe(3);
  });

  it("unions disables and revocations when a mirror lags", () => {
    const oldPolicy = derived({ disabled_features: ["old"], floor_seq: 2 });
    const newPolicy = derived({
      disabled_features: ["new"],
      floor_seq: 3,
      revoked_key_ids: ["k1"],
    });
    register(2, oldPolicy);
    register(3, newPolicy);
    const result = effectivePolicy({
      copies: {
        db: copy(3, newPolicy),
        home: copy(2, oldPolicy),
        userData: copy(3, newPolicy),
      },
      verifier,
    });
    expect(result.status).toBe("inconsistent");
    expect(result.failClosed).toBe(true);
    expect(result.disabled_features).toEqual(["new", "old"]);
    expect(result.revoked_key_ids).toEqual(["k1"]);
    expect(result.authoritative?.epoch).toBe(3);
  });

  it("does not re-enable a feature when the database is lost", () => {
    const policy = derived({ disabled_features: ["x"] });
    register(4, policy);
    const c = copy(4, policy);
    const result = effectivePolicy({
      copies: { db: null, home: c, userData: c },
      verifier,
    });
    expect(result.failClosed).toBe(true);
    expect(result.disabled_features).toEqual(["x"]);
  });

  it("still unions a copy whose signature fails", () => {
    const good = derived({ disabled_features: ["g"] });
    const bad = derived({ disabled_features: ["b"] });
    register(5, good);
    register(6, bad);
    const result = effectivePolicy({
      copies: {
        db: copy(5, good),
        home: copy(6, bad, { sig_bytes: "forged" }),
        userData: copy(5, good),
      },
      verifier,
    });
    expect(result.status).toBe("inconsistent");
    expect(result.disabled_features).toEqual(["b", "g"]);
    expect(result.authoritative?.epoch).toBe(5);
  });

  it("is inconsistent when a mirror's derived fields differ from its own head", () => {
    const real = derived({ disabled_features: ["a"] });
    register(7, real);
    const tampered = copy(7, derived({ disabled_features: [] }));
    const result = effectivePolicy({
      copies: { db: copy(7, real), home: copy(7, real), userData: tampered },
      verifier,
    });
    expect(result.status).toBe("inconsistent");
    expect(result.disabled_features).toEqual(["a"]);
  });

  it("treats a copy signed by a key revoked in any copy as invalid", () => {
    const policy = derived({ revoked_key_ids: ["key-a"] });
    register(8, policy);
    const c = copy(8, policy);
    const result = effectivePolicy({
      copies: { db: c, home: c, userData: c },
      verifier,
    });
    expect(result.status).toBe("reenroll_required");
    expect(result.failClosed).toBe(true);
    expect(result.revoked_key_ids).toEqual(["key-a"]);
    expect(result.authoritative).toBeNull();
  });

  it("requires re-enrollment when copies exist but none is valid", () => {
    const policy = derived({ disabled_features: ["z"] });
    register(9, policy);
    const forged = copy(9, policy, { sig_bytes: "forged" });
    const result = effectivePolicy({
      copies: { db: forged, home: null, userData: null },
      verifier,
    });
    expect(result.status).toBe("reenroll_required");
    expect(result.disabled_features).toEqual(["z"]);
  });

  it("is inconsistent when epochs or semantic hashes differ", () => {
    const policy = derived();
    register(10, policy);
    const c = copy(10, policy);
    const result = effectivePolicy({
      copies: {
        db: c,
        home: { ...c, semantic_sha256: "other" },
        userData: c,
      },
      verifier,
    });
    expect(result.status).toBe("inconsistent");
  });
});

describe("loadEffectivePolicy", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aleph-policy-"));
    mkdirSync(join(dir, "userData"));
    mkdirSync(join(dir, "data"));
  });
  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  function writeMirror(path: string, policyCopy: PolicyCopy): void {
    const body = {
      ...policyCopy,
      derived_sha256: computeDerivedSha256(policyCopy.derived),
    };
    writeFileSync(
      path,
      JSON.stringify({ ...body, checksum: computeMirrorChecksum(body) }),
    );
  }

  it("reads both mirrors and the injected database row", () => {
    const policy = derived({ disabled_features: ["m"] });
    register(11, policy);
    const c = copy(11, policy);
    writeMirror(formatUserDataUpdateStatePath(join(dir, "userData")), c);
    writeMirror(formatAlephUpdateStatePath(join(dir, "data")), c);
    const result = loadEffectivePolicy({
      dataDir: join(dir, "data"),
      readDatabaseCopy: () => c,
      userDataDir: join(dir, "userData"),
      verifier,
    });
    expect(result.status).toBe("consistent");
  });

  it("treats a corrupt mirror as absent but keeps fail-closed", () => {
    const policy = derived({ disabled_features: ["m"] });
    register(12, policy);
    const c = copy(12, policy);
    writeFileSync(formatAlephUpdateStatePath(join(dir, "data")), "{not json");
    const result = loadEffectivePolicy({
      dataDir: join(dir, "data"),
      readDatabaseCopy: () => c,
      userDataDir: join(dir, "userData"),
      verifier,
    });
    expect(result.status).toBe("inconsistent");
    expect(result.failClosed).toBe(true);
    expect(result.disabled_features).toEqual(["m"]);
  });

  it("rejects a mirror whose checksum does not match", () => {
    const policy = derived({ disabled_features: ["m"] });
    register(13, policy);
    const c = copy(13, policy);
    const path = formatAlephUpdateStatePath(join(dir, "data"));
    writeMirror(path, c);
    const tampered = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    tampered.epoch = 99;
    writeFileSync(path, JSON.stringify(tampered));
    const result = loadEffectivePolicy({
      dataDir: join(dir, "data"),
      readDatabaseCopy: () => c,
      userDataDir: join(dir, "userData"),
      verifier,
    });
    expect(result.status).toBe("inconsistent");
  });
});

describe("pluginPolicyDisabledDetail", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aleph-plugin-policy-"));
  });
  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  function writeHomeMirror(features: string[]): void {
    const policyCopy = copy(20, derived({ disabled_features: features }));
    const body = {
      ...policyCopy,
      derived_sha256: computeDerivedSha256(policyCopy.derived),
    };
    writeFileSync(
      formatAlephUpdateStatePath(dir),
      JSON.stringify({ ...body, checksum: computeMirrorChecksum(body) }),
    );
  }

  const gate = (pluginId: string) =>
    pluginPolicyDisabledDetail({
      dataDir: dir,
      pluginId,
      readDatabaseCopy: () => null,
      userDataDir: null,
      verifier: failClosedPolicyVerifier,
    });

  it("does not disable anything before any policy state exists", () => {
    expect(gate("github")).toBeNull();
  });

  it("disables a plugin named in an unverifiable mirror", () => {
    writeHomeMirror(["plugin:github"]);
    expect(gate("github")).toContain("disabled by Aleph update policy");
    expect(gate("docs")).toBeNull();
  });
});
