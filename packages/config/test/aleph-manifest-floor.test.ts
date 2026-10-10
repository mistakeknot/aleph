import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { open, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlephManifestError,
  canonicalJson,
  manifestDigest,
  type AlephManifest,
} from "../src/aleph-manifest.js";
import {
  acceptManifest,
  loadFloorState,
  type FloorStateFiles,
  type PinnedFloor,
} from "../src/aleph-manifest-floor.js";
import {
  FakeSecurityKey,
  hex64,
  makeManifest,
  makeRelease,
} from "./aleph-manifest-fixtures.js";

const failNextClose = vi.hoisted(() => ({ armed: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: (async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (failNextClose.armed && args[1] === "a+") {
        failNextClose.armed = false;
        const realClose = handle.close.bind(handle);
        handle.close = async () => {
          await realClose();
          throw new Error("close failed");
        };
      }
      return handle;
    }) as typeof original.open,
  };
});

const nativeLocks = createRequire(import.meta.url)("fs-native-extensions") as {
  tryLock: (fd: number) => boolean;
  unlock: (fd: number) => void;
};
const realTryLock = nativeLocks.tryLock;
const tryLockSpy = vi.spyOn(nativeLocks, "tryLock");

const scratch = mkdtempSync(join(tmpdir(), "aleph-manifest-floor-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const key = new FakeSecurityKey();
const NOW = new Date("2026-10-10T00:00:00Z");

interface Generation {
  bytes: string;
  signature: string;
  digest: string;
  manifest: AlephManifest;
}

function generation(
  manifest: Partial<AlephManifest> & { sequence: number },
): Generation {
  const full = makeManifest({
    signer_fingerprint: key.fingerprint,
    ...manifest,
  });
  const bytes = canonicalJson(full);
  return {
    bytes,
    signature: key.sign(bytes),
    digest: manifestDigest(bytes),
    manifest: full,
  };
}

function chain(length: number): Generation[] {
  const out: Generation[] = [];
  for (let seq = 1; seq <= length; seq += 1) {
    const previous = out[seq - 2];
    out.push(
      generation({
        sequence: seq,
        previous_digest: previous?.digest ?? null,
        releases: Array.from({ length: seq }, (_, i) =>
          makeRelease(`0.5.${4 + i}`),
        ),
      }),
    );
  }
  return out;
}

function pinned(g: Generation): PinnedFloor {
  return {
    sequence: g.manifest.sequence,
    digest: g.digest,
    issued_at: g.manifest.issued_at,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(scratch, "state-"));
});

async function accept(
  g: Generation,
  floor: PinnedFloor,
  extra: {
    now?: Date;
    persist?: boolean;
    fs?: Partial<FloorStateFiles>;
    lockTimeoutMs?: number;
  } = {},
) {
  return acceptManifest({
    manifestBytes: g.bytes,
    signature: g.signature,
    allowedSigners: key.allowedSigners(),
    stateDir: dir,
    pinnedFloor: floor,
    now: extra.now ?? NOW,
    persist: extra.persist,
    files: extra.fs,
    lockTimeoutMs: extra.lockTimeoutMs,
  });
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AlephManifestError) return error.code;
    throw error;
  }
  return "no-error";
}

describe("acceptance rules", () => {
  it("accepts the pinned generation itself and persists floor and bytes", async () => {
    const [g1] = chain(1);
    const result = await accept(g1!, pinned(g1!));
    expect(result.manifest).toEqual(g1!.manifest);
    expect(result.persisted).toBe(true);
    const state = await loadFloorState(dir, pinned(g1!));
    expect(state.floor).toEqual(pinned(g1!));
    expect(state.lastManifest).toBe(g1!.bytes);
  });

  it("refuses a first use below the pinned floor", async () => {
    const gens = chain(3);
    expect(await codeOf(() => accept(gens[0]!, pinned(gens[2]!)))).toBe(
      "sequence-below-floor",
    );
    expect((await loadFloorState(dir, pinned(gens[2]!))).floor.sequence).toBe(
      3,
    );
  });

  it("refuses an equal sequence with different bytes and flags it as an incident", async () => {
    const gens = chain(2);
    await accept(gens[1]!, pinned(gens[0]!));
    const forked = generation({
      sequence: 2,
      previous_digest: gens[0]!.digest,
      releases: [makeRelease("0.5.4"), makeRelease("0.5.9")],
    });
    try {
      await accept(forked, pinned(gens[0]!));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AlephManifestError);
      expect((error as AlephManifestError).code).toBe("sequence-conflict");
      expect((error as AlephManifestError).escalate).toBe(true);
    }
  });

  it("accepts an equal sequence with an equal digest", async () => {
    const gens = chain(2);
    await accept(gens[1]!, pinned(gens[0]!));
    expect(await codeOf(() => accept(gens[1]!, pinned(gens[0]!)))).toBe(
      "no-error",
    );
  });

  it("refuses an older sequence once the floor advanced", async () => {
    const gens = chain(3);
    await accept(gens[2]!, pinned(gens[0]!));
    expect(await codeOf(() => accept(gens[1]!, pinned(gens[0]!)))).toBe(
      "sequence-below-floor",
    );
  });

  it("refuses an issued_at earlier than the floor's", async () => {
    const [g1] = chain(1);
    const older = generation({
      sequence: 2,
      previous_digest: g1!.digest,
      issued_at: "2026-10-05T12:00:00Z",
      expires_at: "2026-11-04T12:00:00Z",
      releases: g1!.manifest.releases,
    });
    expect(await codeOf(() => accept(older, pinned(g1!)))).toBe(
      "issued-before-floor",
    );
  });

  it("refuses an issued_at more than five minutes ahead and allows five", async () => {
    const earlierFloor: PinnedFloor = {
      sequence: 1,
      digest: hex64("earlier"),
      issued_at: "2026-10-06T12:00:00Z",
    };
    const ahead = (minutes: number) =>
      generation({
        sequence: 2,
        previous_digest: earlierFloor.digest,
        issued_at: new Date(NOW.getTime() + minutes * 60_000)
          .toISOString()
          .replace(".000Z", "Z"),
        expires_at: "2026-11-09T00:00:00Z",
      });
    expect(await codeOf(() => accept(ahead(6), earlierFloor))).toBe(
      "issued-in-future",
    );
    expect(await codeOf(() => accept(ahead(5), earlierFloor))).toBe("no-error");
  });

  it("refuses an expired manifest and a validity longer than 35 days", async () => {
    const expired = generation({
      sequence: 1,
      expires_at: "2026-10-09T00:00:00Z",
    });
    expect(await codeOf(() => accept(expired, pinned(expired)))).toBe(
      "expired",
    );
    const atExpiry = generation({
      sequence: 1,
      expires_at: "2026-10-10T00:00:00Z",
    });
    expect(await codeOf(() => accept(atExpiry, pinned(atExpiry)))).toBe(
      "expired",
    );
    const tooLong = generation({
      sequence: 1,
      issued_at: "2026-10-06T12:00:00Z",
      expires_at: "2026-11-10T12:00:01Z",
    });
    expect(await codeOf(() => accept(tooLong, pinned(tooLong)))).toBe(
      "validity-too-long",
    );
    const exactly = generation({
      sequence: 1,
      issued_at: "2026-10-06T12:00:00Z",
      expires_at: "2026-11-10T12:00:00Z",
    });
    expect(await codeOf(() => accept(exactly, pinned(exactly)))).toBe(
      "no-error",
    );
  });

  it("refuses when the clock is behind the floor's issue time", async () => {
    const [g1] = chain(1);
    const rolledBack = new Date("2026-09-01T00:00:00Z");
    expect(
      await codeOf(() => accept(g1!, pinned(g1!), { now: rolledBack })),
    ).toBe("clock-rollback");
  });

  it("refuses a bad signature before touching the floor", async () => {
    const [g1] = chain(1);
    const attacker = new FakeSecurityKey();
    const forged = { ...g1!, signature: attacker.sign(g1!.bytes) };
    expect(await codeOf(() => accept(forged, pinned(g1!)))).toBe(
      "signature-invalid",
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses non-canonical bytes even with a valid signature", async () => {
    const [g1] = chain(1);
    const pretty = JSON.stringify(g1!.manifest, null, 2);
    const forged = { ...g1!, bytes: pretty, signature: key.sign(pretty) };
    expect(await codeOf(() => accept(forged, pinned(g1!)))).toBe(
      "non-canonical",
    );
  });
});

describe("floor persistence", () => {
  it("advances on refresh and keeps the latest manifest bytes", async () => {
    const gens = chain(3);
    await accept(gens[0]!, pinned(gens[0]!));
    await accept(gens[2]!, pinned(gens[0]!));
    const state = await loadFloorState(dir, pinned(gens[0]!));
    expect(state.floor).toEqual(pinned(gens[2]!));
    expect(state.lastManifest).toBe(gens[2]!.bytes);
    expect(readdirSync(dir).sort()).toEqual(["floor.json", "floor.lock"]);
  });

  it("keeps the old floor when the process dies between write and rename", async () => {
    const gens = chain(2);
    await accept(gens[0]!, pinned(gens[0]!));
    await expect(
      accept(gens[1]!, pinned(gens[0]!), {
        fs: {
          rename: async () => {
            throw new Error("injected crash before rename");
          },
        },
      }),
    ).rejects.toThrow("injected crash");
    const state = await loadFloorState(dir, pinned(gens[0]!));
    expect(state.floor).toEqual(pinned(gens[0]!));
    expect(state.lastManifest).toBe(gens[0]!.bytes);
    await accept(gens[1]!, pinned(gens[0]!));
    expect((await loadFloorState(dir, pinned(gens[0]!))).floor.sequence).toBe(
      2,
    );
  });

  it("fsyncs the temp file before the rename and the directory after it", async () => {
    const [g1] = chain(1);
    const events: string[] = [];
    await accept(g1!, pinned(g1!), {
      fs: {
        fsyncFile: async () => {
          events.push("fsync-file");
        },
        rename: async (from: string, to: string) => {
          events.push("rename");
          const { rename } = await import("node:fs/promises");
          await rename(from, to);
        },
        fsyncDir: async () => {
          events.push("fsync-dir");
        },
      },
    });
    expect(events).toEqual(["fsync-file", "rename", "fsync-dir"]);
  });

  it("writes nothing under no-persist, and a later persisting call still works", async () => {
    const gens = chain(2);
    const result = await accept(gens[1]!, pinned(gens[0]!), { persist: false });
    expect(result.persisted).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    await accept(gens[1]!, pinned(gens[0]!));
    expect(readFileSync(join(dir, "floor.json"), "utf8")).toContain(
      `"sequence":2`,
    );
  });

  it("rejects a tampered state file instead of resetting to the pinned floor", async () => {
    const gens = chain(2);
    await accept(gens[1]!, pinned(gens[0]!));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "floor.json"), "{ not json");
    expect(await codeOf(() => loadFloorState(dir, pinned(gens[0]!)))).toBe(
      "state-corrupt",
    );
    writeFileSync(
      join(dir, "floor.json"),
      JSON.stringify({
        floor: {
          sequence: 1,
          digest: hex64("x"),
          issued_at: "2026-10-06T12:00:00Z",
        },
        last_manifest: gens[1]!.bytes,
      }),
    );
    expect(await codeOf(() => loadFloorState(dir, pinned(gens[0]!)))).toBe(
      "state-corrupt",
    );
  });
});

describe("skip-generation", () => {
  it("accepts a client three generations behind against its cached manifest", async () => {
    const gens = chain(5);
    await accept(gens[1]!, pinned(gens[0]!));
    const result = await accept(gens[4]!, pinned(gens[0]!));
    expect(result.manifest.sequence).toBe(5);
    expect((await loadFloorState(dir, pinned(gens[0]!))).floor.sequence).toBe(
      5,
    );
  });

  it("refuses a mutated old entry in the new generation", async () => {
    const gens = chain(5);
    await accept(gens[1]!, pinned(gens[0]!));
    const mutated = generation({
      sequence: 5,
      previous_digest: gens[3]!.digest,
      releases: [
        makeRelease("0.5.4", { protocol_version: 999 }),
        ...gens[4]!.manifest.releases.slice(1),
      ],
    });
    expect(await codeOf(() => accept(mutated, pinned(gens[0]!)))).toBe(
      "release-mutated",
    );
    expect((await loadFloorState(dir, pinned(gens[0]!))).floor.sequence).toBe(
      2,
    );
  });
});

function revocation(aleph: string, sequence: number) {
  return { aleph, reason: "synthetic", sequence };
}

describe("catch-up across revocations", () => {
  function history() {
    const g1 = generation({ sequence: 1, previous_digest: null });
    const revocations = [revocation("0.5.4", 2)];
    const g2 = generation({
      sequence: 2,
      previous_digest: g1.digest,
      releases: [makeRelease("0.5.4"), makeRelease("0.5.5")],
      revocations,
    });
    const g3 = generation({
      sequence: 3,
      previous_digest: g2.digest,
      releases: g2.manifest.releases,
      revocations,
    });
    const g4 = generation({
      sequence: 4,
      previous_digest: g3.digest,
      releases: g2.manifest.releases,
      revocations,
    });
    return { g1, g2, g3, g4 };
  }

  it("accepts an intermediate revocation after skipping generations", async () => {
    const { g1, g2, g3, g4 } = history();
    await accept(g1, pinned(g1));
    expect(await codeOf(() => accept(g2, pinned(g1)))).toBe("no-error");
    expect(await codeOf(() => accept(g3, pinned(g1)))).toBe("no-error");
    expect(await codeOf(() => accept(g4, pinned(g1)))).toBe("no-error");

    dir = mkdtempSync(join(scratch, "state-"));
    await accept(g1, pinned(g1));
    expect(await codeOf(() => accept(g4, pinned(g1)))).toBe("no-error");
    expect((await loadFloorState(dir, pinned(g1))).floor.sequence).toBe(4);
  });

  it("refuses a backdated revocation introduced at or before the cached sequence", async () => {
    const { g1, g2 } = history();
    await accept(g2, pinned(g1));
    const backdated = generation({
      sequence: 5,
      previous_digest: "0".repeat(64),
      releases: [...g2.manifest.releases, makeRelease("0.5.6")],
      revocations: [...g2.manifest.revocations, revocation("0.5.6", 2)],
    });
    expect(await codeOf(() => accept(backdated, pinned(g1)))).toBe(
      "revocation-sequence",
    );
  });

  it("refuses a revocation introduced after the fetched sequence", async () => {
    const { g1, g2 } = history();
    await accept(g2, pinned(g1));
    const future = generation({
      sequence: 5,
      previous_digest: "0".repeat(64),
      releases: [...g2.manifest.releases, makeRelease("0.5.6")],
      revocations: [...g2.manifest.revocations, revocation("0.5.6", 6)],
    });
    expect(await codeOf(() => accept(future, pinned(g1)))).toBe("schema");
  });

  it("still requires the current sequence for a consecutive transition", async () => {
    const { g1, g2 } = history();
    await accept(g2, pinned(g1));
    const consecutive = generation({
      sequence: 3,
      previous_digest: g2.digest,
      releases: [...g2.manifest.releases, makeRelease("0.5.6")],
      revocations: [...g2.manifest.revocations, revocation("0.5.6", 2)],
    });
    expect(await codeOf(() => accept(consecutive, pinned(g1)))).toBe(
      "revocation-sequence",
    );
  });

  it("accepts a release added and then revoked during skipped generations", async () => {
    const g1 = generation({ sequence: 1, previous_digest: null });
    const added = [makeRelease("0.5.4"), makeRelease("0.5.5")];
    const g2 = generation({
      sequence: 2,
      previous_digest: g1.digest,
      releases: added,
    });
    const g3 = generation({
      sequence: 3,
      previous_digest: g2.digest,
      releases: added,
      revocations: [revocation("0.5.5", 3)],
    });
    await accept(g1, pinned(g1));
    expect(await codeOf(() => accept(g3, pinned(g1)))).toBe("no-error");
    expect((await loadFloorState(dir, pinned(g1))).floor.sequence).toBe(3);
  });

  it("still refuses a release already revoked in the cached manifest reappearing as new", async () => {
    const g1 = generation({
      sequence: 1,
      previous_digest: null,
      revocations: [revocation("0.5.5", 1)],
    });
    const resurrect = generation({
      sequence: 4,
      previous_digest: "0".repeat(64),
      releases: [makeRelease("0.5.4"), makeRelease("0.5.5")],
      revocations: g1.manifest.revocations,
    });
    await accept(g1, pinned(g1));
    expect(await codeOf(() => accept(resurrect, pinned(g1)))).toBe(
      "revoked-reappears",
    );
  });

  it("still refuses a consecutive generation that adds an already revoked release", async () => {
    const g1 = generation({ sequence: 1, previous_digest: null });
    const both = generation({
      sequence: 2,
      previous_digest: g1.digest,
      releases: [makeRelease("0.5.4"), makeRelease("0.5.5")],
      revocations: [revocation("0.5.5", 2)],
    });
    await accept(g1, pinned(g1));
    expect(await codeOf(() => accept(both, pinned(g1)))).toBe(
      "revoked-reappears",
    );
  });
});

describe("concurrent observations", () => {
  it("never lets a stale writer lower the durable floor", async () => {
    const gens = chain(3);
    const floor = pinned(gens[0]!);
    await accept(gens[0]!, floor);
    let arrived!: () => void;
    const atRename = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const slow = accept(gens[1]!, floor, {
      fs: {
        rename: async (from, to) => {
          arrived();
          await gate;
          await rename(from, to);
        },
      },
    });
    await atRename;
    const fast = accept(gens[2]!, floor);
    await new Promise((resolve) => setTimeout(resolve, 150));
    proceed();
    await Promise.allSettled([slow, fast]);
    expect((await loadFloorState(dir, floor)).floor.sequence).toBe(3);
  });

  it("lets only one of two same-sequence manifests win", async () => {
    const g1 = generation({ sequence: 1, previous_digest: null });
    const a = generation({ sequence: 2, previous_digest: g1.digest });
    const b = generation({
      sequence: 2,
      previous_digest: g1.digest,
      expires_at: "2026-11-04T12:00:00Z",
    });
    await accept(g1, pinned(g1));
    const outcomes = await Promise.all(
      [a, b].map((g) => codeOf(() => accept(g, pinned(g1)))),
    );
    expect(outcomes.sort()).toEqual(["no-error", "sequence-conflict"]);
  });

  it("recovers a lock left by a process that no longer exists", async () => {
    const gens = chain(2);
    const floor = pinned(gens[0]!);
    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(join(dir, "floor.lock"), String(dead.pid));
    expect(await codeOf(() => accept(gens[1]!, floor))).toBe("no-error");
  });

  it("releases the lock when persistence fails", async () => {
    const gens = chain(2);
    const floor = pinned(gens[0]!);
    await expect(
      accept(gens[1]!, floor, {
        fs: {
          rename: async () => {
            throw new Error("boom");
          },
        },
      }),
    ).rejects.toThrow("boom");
    expect(await codeOf(() => accept(gens[1]!, floor))).toBe("no-error");
  });

  it("recovers when the lock file holds a reused live pid and is old", async () => {
    const gens = chain(2);
    const floor = pinned(gens[0]!);
    const lock = join(dir, "floor.lock");
    writeFileSync(lock, String(process.pid));
    utimesSync(lock, new Date(0), new Date(0));
    expect(await codeOf(() => accept(gens[1]!, floor))).toBe("no-error");
  });

  it("keeps a genuinely held old lock and reports state-locked", async () => {
    const gens = chain(2);
    const floor = pinned(gens[0]!);
    const lock = join(dir, "floor.lock");
    const holder = await open(lock, "a+", 0o600);
    try {
      expect(realTryLock(holder.fd)).toBe(true);
      utimesSync(lock, new Date(0), new Date(0));
      const started = Date.now();
      expect(
        await codeOf(() => accept(gens[1]!, floor, { lockTimeoutMs: 300 })),
      ).toBe("state-locked");
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(readdirSync(dir)).toContain("floor.lock");
      nativeLocks.unlock(holder.fd);
    } finally {
      await holder.close();
    }
    expect(await codeOf(() => accept(gens[1]!, floor))).toBe("no-error");
  });

  it("times out after thirty seconds by default", async () => {
    const gens = chain(2);
    const floor = pinned(gens[0]!);
    const holder = await open(join(dir, "floor.lock"), "a+", 0o600);
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      expect(realTryLock(holder.fd)).toBe(true);
      const pending = codeOf(() => accept(gens[1]!, floor));
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        vi.advanceTimersByTime(1_000);
      }
      expect(await pending).toBe("state-locked");
    } finally {
      vi.useRealTimers();
      nativeLocks.unlock(holder.fd);
      await holder.close();
    }
  });

  it("serializes many contenders over an orphaned lock without losing a revocation", async () => {
    const g1 = generation({ sequence: 1, previous_digest: null });
    const revocations = [revocation("0.5.4", 3)];
    const g2 = generation({
      sequence: 2,
      previous_digest: g1.digest,
      releases: [makeRelease("0.5.4"), makeRelease("0.5.5")],
    });
    const g2b = generation({
      sequence: 2,
      previous_digest: g1.digest,
      releases: [makeRelease("0.5.4"), makeRelease("0.5.5")],
      expires_at: "2026-11-04T12:00:00Z",
    });
    const g3 = generation({
      sequence: 3,
      previous_digest: g2.digest,
      releases: g2.manifest.releases,
      revocations,
    });
    await accept(g1, pinned(g1));
    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(join(dir, "floor.lock"), String(dead.pid));
    let arrived!: () => void;
    const atRename = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const slow = codeOf(() =>
      accept(g2, pinned(g1), {
        fs: {
          rename: async (from, to) => {
            arrived();
            await gate;
            await rename(from, to);
          },
        },
      }),
    );
    await atRename;
    const others = [g3, g2b, g3, g2b, g3, g2b].map((g) =>
      codeOf(() => accept(g, pinned(g1))),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    proceed();
    expect(await slow).toBe("no-error");
    const outcomes = await Promise.all(others);
    for (const index of [0, 2, 4]) expect(outcomes[index]).toBe("no-error");
    for (const index of [1, 3, 5]) {
      expect(["sequence-conflict", "sequence-below-floor"]).toContain(
        outcomes[index],
      );
    }
    const state = await loadFloorState(dir, pinned(g1));
    expect(state.floor.sequence).toBe(3);
    expect(state.lastManifest).toBe(g3.bytes);
    expect(await codeOf(() => accept(g2, pinned(g1)))).toBe(
      "sequence-below-floor",
    );
  });

  it("serializes real processes and releases when a holder is killed", async () => {
    const gens = chain(2);
    const floor = pinned(gens[0]!);
    const lock = join(dir, "floor.lock");
    const modulePath = createRequire(import.meta.url).resolve(
      "fs-native-extensions",
    );
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("node:fs");const n=require(${JSON.stringify(modulePath)});` +
          `const fd=fs.openSync(${JSON.stringify(lock)},"a+");` +
          `if(!n.tryLock(fd))process.exit(3);process.stdout.write("held\\n");setInterval(()=>{},1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("exit", (code) => reject(new Error(`child exit ${code}`)));
        child.stdout.once("data", () => resolve());
      });
      expect(
        await codeOf(() => accept(gens[1]!, floor, { lockTimeoutMs: 300 })),
      ).toBe("state-locked");
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      expect(await codeOf(() => accept(gens[1]!, floor))).toBe("no-error");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("does not leak the lock when acquisition fails, and preserves the error", async () => {
    const gens = chain(2);
    const floor = pinned(gens[0]!);
    tryLockSpy.mockImplementationOnce(() => {
      throw new Error("init failed");
    });
    await expect(accept(gens[1]!, floor)).rejects.toThrow("init failed");
    expect(await codeOf(() => accept(gens[1]!, floor))).toBe("no-error");
  });

  it("makes progress after a close failure on the lock handle", async () => {
    const gens = chain(2);
    const floor = pinned(gens[0]!);
    failNextClose.armed = true;
    try {
      await expect(accept(gens[1]!, floor)).rejects.toThrow("close failed");
    } finally {
      failNextClose.armed = false;
    }
    expect(await codeOf(() => accept(gens[1]!, floor))).toBe("no-error");
  });
});
