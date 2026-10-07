import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AlephManifestError,
  canonicalJson,
  manifestDigest,
  type AlephManifest,
} from "@bb/config/aleph-manifest";
import {
  ALEPH_UPDATE_PROBE_INSTANCE,
  buildRecoverInstance,
  buildRollbackInstance,
  buildUpdateInstance,
} from "@bb/config/aleph-update-instance";
import { hex64, makeManifest, makeRelease } from "../helpers/aleph-manifest.js";
import { ApiError } from "../../src/errors.js";
import {
  createAlephUpdateService,
  type AlephUpdateAuditRecord,
  type AlephUpdateService,
  type AlephUpdateSystem,
} from "../../src/services/system/aleph-update.js";
import { testLogger } from "../helpers/test-app.js";

const NOW = Date.parse("2026-10-10T00:00:00Z");
const NONCE = "0123456789abcdef0123456789abcdef";
const OTHER_NONCE = "fedcba9876543210fedcba9876543210";
const STATE = "/state";
const PUBLISH = "/publish";
const CONFIG = "/config";
const RULE = "/rules/update.rules";
const RULE_BODY = "polkit.addRule(function () {});\n";
const RULE_HASH = createHash("sha256").update(RULE_BODY).digest("hex");
const PROBE_UNIT = `aleph-update@${ALEPH_UPDATE_PROBE_INSTANCE}.service`;
const GEN = "gen/2-0123456789ab/";

class FakeSystem implements AlephUpdateSystem {
  files = new Map<string, string>();
  loadStates = new Map<string, string>();
  started: string[] = [];
  startResult: "ok" | "denied" | "failed" = "ok";

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async listDir(path: string): Promise<string[] | null> {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        names.add(key.slice(prefix.length).split("/")[0] ?? "");
      }
    }
    return names.size === 0 ? null : [...names];
  }

  async unitLoadState(unit: string): Promise<string> {
    return this.loadStates.get(unit) ?? "not-found";
  }

  async startUnit(unit: string): Promise<"ok" | "denied" | "failed"> {
    this.started.push(unit);
    return this.startResult;
  }
}

interface Rig {
  audit: AlephUpdateAuditRecord[];
  notices: string[];
  service: AlephUpdateService;
  system: FakeSystem;
  setAccept: (result: AlephManifest | Error) => void;
}

function installedState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    installed: {
      aleph: "0.5.3",
      version: "0.44.0+aleph.0.5.3",
      tree_sha256: hex64("tree"),
      migrations: [],
    },
    predecessor: null,
    recovery_required: null,
    ...overrides,
  };
}

function rig(
  options: {
    appVersion?: string;
    capability?: "absent" | "command-only" | "startable";
    manifest?: AlephManifest;
    state?: Record<string, unknown> | null;
    threads?: number;
  } = {},
): Rig {
  const system = new FakeSystem();
  const audit: AlephUpdateAuditRecord[] = [];
  const notices: string[] = [];
  const capability = options.capability ?? "startable";
  if (capability !== "absent") {
    system.loadStates.set(PROBE_UNIT, "loaded");
  }
  if (capability === "startable") {
    system.files.set(`${CONFIG}/capability`, `polkit-start/1 ${RULE_HASH}\n`);
    system.files.set(RULE, RULE_BODY);
  }
  const state = options.state === undefined ? installedState() : options.state;
  if (state !== null) {
    system.files.set(`${STATE}/state.json`, JSON.stringify(state));
  }
  const manifest =
    options.manifest ??
    makeManifest({
      sequence: 2,
      previous_digest: hex64("prior"),
      releases: [makeRelease("0.5.3"), makeRelease("0.5.4")],
    });
  system.files.set(
    `${PUBLISH}/current.json`,
    JSON.stringify({ sequence: manifest.sequence, path: GEN }),
  );
  system.files.set(`${PUBLISH}/${GEN}manifest.json`, canonicalJson(manifest));
  system.files.set(`${PUBLISH}/${GEN}manifest.json.sig`, "signature\n");
  system.files.set(`${CONFIG}/allowed_signers`, "signers\n");
  system.files.set(
    `${CONFIG}/pinned-floor.json`,
    JSON.stringify({
      sequence: 1,
      digest: hex64("floor"),
      issued_at: "2026-01-01T00:00:00Z",
    }),
  );
  let accepted: AlephManifest | Error = manifest;
  const service = createAlephUpdateService({
    accept: async () => {
      if (accepted instanceof Error) throw accepted;
      return { manifest: accepted, persisted: true };
    },
    appVersion: options.appVersion ?? "0.44.0+aleph.0.5.3",
    audit: (record) => audit.push(record),
    countRunningThreads: () => options.threads ?? 0,
    logger: testLogger,
    notify: async (message) => {
      notices.push(message);
    },
    now: () => NOW,
    paths: {
      configDir: CONFIG,
      floorStateDir: "/floor",
      polkitRulePath: RULE,
      publishDir: PUBLISH,
      stateDir: STATE,
    },
    platform: "linux",
    system,
  });
  return {
    audit,
    notices,
    service,
    system,
    setAccept: (result) => {
      accepted = result;
    },
  };
}

function putRun(
  system: FakeSystem,
  counter: number,
  nonce: string,
  files: {
    started?: Record<string, unknown>;
    outcome?: Record<string, unknown>;
  },
): void {
  const base = `${STATE}/runs/${counter}-${nonce}`;
  system.files.set(`${base}/request.json`, "{}");
  if (files.started) {
    system.files.set(`${base}/started.json`, JSON.stringify(files.started));
  }
  if (files.outcome) {
    system.files.set(`${base}/outcome.json`, JSON.stringify(files.outcome));
  }
}

const UPDATE = {
  interrupt: false,
  manifestDigest: hex64("digest"),
  nonce: NONCE,
  operation: "update" as const,
  target: "0.5.4",
};

describe("aleph update service status", () => {
  it("offers a newer release with its digest", async () => {
    const { service } = rig();
    const status = await service.getStatus();
    const manifest = makeManifest({
      sequence: 2,
      previous_digest: hex64("prior"),
      releases: [makeRelease("0.5.3"), makeRelease("0.5.4")],
    });
    expect(status).toMatchObject({
      activeThreadCount: 0,
      capability: "startable",
      selection: "available",
      installed: { aleph: "0.5.3", version: "0.44.0+aleph.0.5.3" },
      predecessor: null,
      target: {
        aleph: "0.5.4",
        version: "0.44.0+aleph.0.5.4",
        manifestDigest: manifestDigest(canonicalJson(manifest)),
      },
      floor: {
        sequence: 2,
        issuedAt: "2026-10-06T12:00:00Z",
        ageSeconds: Math.floor(
          (NOW - Date.parse("2026-10-06T12:00:00Z")) / 1000,
        ),
      },
    });
  });

  it("reports up to date when the newest release is installed", async () => {
    const { service } = rig({
      manifest: makeManifest({
        sequence: 2,
        previous_digest: hex64("prior"),
        releases: [makeRelease("0.5.3")],
      }),
    });
    const status = await service.getStatus();
    expect(status.selection).toBe("up-to-date");
    expect(status.target).toBeNull();
  });

  it("flags a migration-required target", async () => {
    const newer = makeRelease("0.5.4", {
      db: {
        migrations: [
          { tag: "0001_first", when: 1759000000000, sha256: hex64("other") },
        ],
      },
    });
    const { service } = rig({
      manifest: makeManifest({
        sequence: 2,
        previous_digest: hex64("prior"),
        releases: [makeRelease("0.5.3"), newer],
      }),
    });
    expect((await service.getStatus()).selection).toBe("migration-required");
  });

  it("flags a revoked installed release", async () => {
    const { service } = rig({
      manifest: makeManifest({
        sequence: 2,
        previous_digest: hex64("prior"),
        releases: [makeRelease("0.5.3"), makeRelease("0.5.4")],
        revocations: [{ aleph: "0.5.3", reason: "bad", sequence: 2 }],
      }),
    });
    expect((await service.getStatus()).selection).toBe("installed-revoked");
  });

  it("reports the manifest as missing when nothing is published", async () => {
    const { service, system } = rig();
    system.files.delete(`${PUBLISH}/current.json`);
    const status = await service.getStatus();
    expect(status.selection).toBe("manifest-missing");
    expect(status.detail).toMatch(/manifest/i);
    expect(status.floor).toBeNull();
  });

  it("reports an unreadable pointer as invalid", async () => {
    const { service, system } = rig();
    system.files.set(`${PUBLISH}/current.json`, "{not json");
    expect((await service.getStatus()).selection).toBe("manifest-invalid");
    system.files.set(
      `${PUBLISH}/current.json`,
      JSON.stringify({ sequence: 2, path: "../escape/" }),
    );
    expect((await service.getStatus()).selection).toBe("manifest-invalid");
  });

  it("maps an expired manifest and other verification failures", async () => {
    const { service, setAccept } = rig();
    setAccept(new AlephManifestError("expired", "manifest has expired"));
    expect((await service.getStatus()).selection).toBe("manifest-expired");
    setAccept(new AlephManifestError("signature-invalid", "bad signature"));
    const invalid = await service.getStatus();
    expect(invalid.selection).toBe("manifest-invalid");
    expect(invalid.detail).toBe("bad signature");
    setAccept(new Error("disk exploded"));
    expect((await service.getStatus()).selection).toBe("manifest-invalid");
  });

  it("surfaces the recovery requirement and an active recover run", async () => {
    const { service, system } = rig({
      state: installedState({ recovery_required: { run: `3-${NONCE}` } }),
    });
    expect((await service.getStatus()).selection).toBe("recovery-required");
    putRun(system, 4, OTHER_NONCE, {
      started: {
        invocation_id: "inv",
        counter: 4,
        op: "recover",
        from: null,
        to: null,
      },
    });
    expect((await service.getStatus()).selection).toBe("recovering");
  });

  it("carries the predecessor and the active thread count", async () => {
    const { service } = rig({
      state: installedState({
        predecessor: { aleph: "0.5.2", version: "0.44.0+aleph.0.5.2" },
      }),
      threads: 3,
    });
    const status = await service.getStatus();
    expect(status.predecessor).toEqual({
      aleph: "0.5.2",
      version: "0.44.0+aleph.0.5.2",
    });
    expect(status.activeThreadCount).toBe(3);
  });

  it("falls back to the running version when no state exists", async () => {
    const { service } = rig({ state: null });
    expect((await service.getStatus()).installed).toEqual({
      aleph: "0.5.3",
      version: "0.44.0+aleph.0.5.3",
    });
  });

  it("computes the three capabilities", async () => {
    expect(
      (await rig({ capability: "absent" }).service.getStatus()).capability,
    ).toBe("absent");
    expect(
      (await rig({ capability: "command-only" }).service.getStatus())
        .capability,
    ).toBe("command-only");
    const mismatched = rig({ capability: "startable" });
    mismatched.system.files.set(RULE, "something else\n");
    expect((await mismatched.service.getStatus()).capability).toBe(
      "command-only",
    );
    const noRule = rig({ capability: "startable" });
    noRule.system.files.delete(RULE);
    expect((await noRule.service.getStatus()).capability).toBe("command-only");
  });
});

describe("aleph update service start", () => {
  it("starts the instance unit and reports queued", async () => {
    const { audit, notices, service, system } = rig();
    const run = await service.start(UPDATE);
    expect(run).toEqual({ detail: null, nonce: NONCE, state: "queued" });
    expect(system.started).toEqual([
      `aleph-update@${buildUpdateInstance({
        digest: UPDATE.manifestDigest,
        interrupt: false,
        nonce: NONCE,
        version: "0.5.4",
      })}.service`,
    ]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      nonce: NONCE,
      operation: "update",
      outcome: "started",
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(NONCE);
  });

  it("encodes the interrupt consent", async () => {
    const { service, system } = rig();
    await service.start({ ...UPDATE, interrupt: true });
    expect(system.started[0]).toContain("_i_");
  });

  it("starts rollback and recover instances", async () => {
    const { service, system } = rig();
    await service.start({
      from: "0.5.4",
      interrupt: false,
      nonce: NONCE,
      operation: "rollback",
      to: "0.5.3",
    });
    await service.start({ nonce: OTHER_NONCE, operation: "recover" });
    expect(system.started).toEqual([
      `aleph-update@${buildRollbackInstance({
        from: "0.5.4",
        interrupt: false,
        nonce: NONCE,
        to: "0.5.3",
      })}.service`,
      `aleph-update@${buildRecoverInstance({ nonce: OTHER_NONCE })}.service`,
    ]);
  });

  it("rejects fields that do not fit the instance grammar", async () => {
    const { service, system } = rig();
    await expect(
      service.start({ ...UPDATE, target: "0.5.4.1" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.start({ ...UPDATE, nonce: "short" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.start({ ...UPDATE, manifestDigest: "zz" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(system.started).toEqual([]);
  });

  it("returns the existing run for a repeated nonce and starts nothing", async () => {
    const { audit, service, system } = rig();
    putRun(system, 5, NONCE, {
      started: {
        invocation_id: "inv",
        counter: 5,
        op: "update",
        from: "0.5.3",
        to: "0.5.4",
      },
    });
    const run = await service.start(UPDATE);
    expect(run.state).toBe("running");
    expect(system.started).toEqual([]);
    expect(audit[0]?.outcome).toBe("existing");
  });

  it("returns a refused record for a repeated nonce", async () => {
    const { service, system } = rig();
    system.files.set(`${STATE}/requests/${NONCE}.inv1.refused`, "stale\n");
    const run = await service.start(UPDATE);
    expect(run.state).toBe("refused");
    expect(system.started).toEqual([]);
  });

  it("answers command-only with a conflict that carries the root command", async () => {
    const { audit, service, system } = rig({ capability: "command-only" });
    const failure = await service.start(UPDATE).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(409);
    expect(failure.body.details).toMatchObject({
      command: expect.stringContaining(NONCE),
    });
    expect(failure.body.details.command).toContain("systemctl");
    expect(system.started).toEqual([]);
    expect(audit[0]?.outcome).toBe("command-only");
  });

  it("answers an absent capability with a conflict", async () => {
    const { service } = rig({ capability: "absent" });
    await expect(service.start(UPDATE)).rejects.toMatchObject({ status: 409 });
  });

  it("explains a denied start in startable mode", async () => {
    const { audit, service, system } = rig();
    system.startResult = "denied";
    const failure = await service.start(UPDATE).catch((error) => error);
    expect(failure.status).toBe(409);
    expect(failure.message).toContain(
      "declared startable but start was denied: polkit rule missing or mismatched",
    );
    expect(failure.body.details.command).toContain(NONCE);
    expect(audit[0]?.outcome).toBe("denied");
  });

  it("surfaces a failed start", async () => {
    const { service, system } = rig();
    system.startResult = "failed";
    await expect(service.start(UPDATE)).rejects.toMatchObject({ status: 502 });
  });

  it("does not let a failing notice break the start", async () => {
    const system = rig();
    const failing = createAlephUpdateService({
      accept: async () => {
        throw new Error("unused");
      },
      appVersion: "0.44.0+aleph.0.5.3",
      audit: () => {},
      countRunningThreads: () => 0,
      logger: testLogger,
      notify: async () => {
        throw new Error("notice sink down");
      },
      now: () => NOW,
      paths: {
        configDir: CONFIG,
        floorStateDir: "/floor",
        polkitRulePath: RULE,
        publishDir: PUBLISH,
        stateDir: STATE,
      },
      platform: "linux",
      system: system.system,
    });
    const run = await failing.start(UPDATE);
    expect(run.state).toBe("queued");
  });
});

describe("aleph update service run lookup", () => {
  it("reports not-found when nothing matches", async () => {
    const { service } = rig();
    expect(await service.getRun(NONCE)).toEqual({
      detail: null,
      nonce: NONCE,
      state: "not-found",
    });
  });

  it("rejects a malformed nonce", async () => {
    const { service } = rig();
    await expect(service.getRun("nope")).rejects.toMatchObject({ status: 400 });
  });

  it("reports queued before the helper has started", async () => {
    const { service, system } = rig();
    putRun(system, 6, NONCE, {});
    expect((await service.getRun(NONCE)).state).toBe("queued");
  });

  it("reports a recover run as recovering until it ends", async () => {
    const { service, system } = rig();
    putRun(system, 7, NONCE, {
      started: {
        invocation_id: "inv",
        counter: 7,
        op: "recover",
        from: null,
        to: null,
      },
    });
    expect((await service.getRun(NONCE)).state).toBe("recovering");
  });

  it.each([
    [0, "succeeded"],
    [10, "aborted"],
    [11, "rolled-back"],
    [12, "recovery-incomplete"],
    [20, "refused"],
    [99, "unknown"],
  ])("maps outcome code %i to %s", async (code, state) => {
    const { service, system } = rig();
    putRun(system, 8, NONCE, {
      started: {
        invocation_id: "inv",
        counter: 8,
        op: "update",
        from: "0.5.3",
        to: "0.5.4",
      },
      outcome: { code, label: "LABEL", ended_at: "2026-10-10T00:00:00Z" },
    });
    expect(await service.getRun(NONCE)).toEqual({
      detail: "LABEL",
      nonce: NONCE,
      state,
    });
  });

  it("prefers a run over a refused record", async () => {
    const { service, system } = rig();
    system.files.set(`${STATE}/requests/${NONCE}.inv1.refused`, "stale\n");
    putRun(system, 9, NONCE, {
      started: {
        invocation_id: "inv",
        counter: 9,
        op: "update",
        from: "0.5.3",
        to: "0.5.4",
      },
    });
    expect((await service.getRun(NONCE)).state).toBe("running");
  });

  it("does not match a different nonce", async () => {
    const { service, system } = rig();
    putRun(system, 10, OTHER_NONCE, {});
    expect((await service.getRun(NONCE)).state).toBe("not-found");
  });
});
