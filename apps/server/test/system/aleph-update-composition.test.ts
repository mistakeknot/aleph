import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerAlephUpdateService } from "../../src/services/system/aleph-update-composition.js";
import type { AlephUpdateSystem } from "../../src/services/system/aleph-update.js";
import { testLogger } from "../helpers/test-app.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const STATE = "/state";
const APP_VERSION = "0.44.0+aleph.0.5.3";

function runningSystem(): AlephUpdateSystem {
  const files = new Map<string, string>([
    [`${STATE}/runs/5-${NONCE}/request.json`, "{}"],
    [
      `${STATE}/runs/5-${NONCE}/started.json`,
      JSON.stringify({
        invocation_id: "inv",
        counter: 5,
        op: "update",
        from: "0.5.3",
        to: "0.5.4",
      }),
    ],
  ]);
  return {
    listDir: async (path) => {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          names.add(key.slice(prefix.length).split("/")[0] ?? "");
        }
      }
      return names.size === 0 ? null : [...names];
    },
    readFile: async (path) => files.get(path) ?? null,
    startUnit: async () => "ok",
    unitLoadState: async () => "not-found",
  };
}

const UPDATE = {
  interrupt: false,
  manifestDigest: "d".repeat(64),
  nonce: NONCE,
  operation: "update" as const,
  target: "0.5.4",
};

let dataDir = "";

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "aleph-composition-"));
});

afterEach(async () => {
  await rm(dataDir, { force: true, recursive: true });
});

function compose(notify?: (message: string) => Promise<void>) {
  return createServerAlephUpdateService({
    appVersion: APP_VERSION,
    countRunningThreads: () => 0,
    dataDir,
    logger: testLogger,
    ...(notify === undefined ? {} : { notify }),
    overrides: {
      paths: {
        configDir: "/config",
        floorStateDir: join(dataDir, "aleph-update"),
        polkitRulePath: "/rule",
        publishDir: "/publish",
        stateDir: STATE,
      },
      platform: "linux",
      system: runningSystem(),
    },
  });
}

describe("aleph update service composition", () => {
  it("supplies a durable audit sink that records each request", async () => {
    const service = compose();
    await service.start(UPDATE);
    const lines = (
      await readFile(join(dataDir, "aleph-update", "audit.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      instance: expect.any(String),
      nonce: NONCE,
      operation: "update",
      outcome: "existing",
    });
    expect(typeof lines[0]?.at).toBe("string");
  });

  it("supplies the injected notice sink", async () => {
    const notify = vi.fn(async () => {});
    await compose(notify).start(UPDATE);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      `Aleph update request ${NONCE}: existing`,
    );
  });

  it("defaults the notice sink to a no-op without failing requests", async () => {
    const run = await compose().start(UPDATE);
    expect(run.state).toBe("running");
  });

  it("refuses the request when the audit file cannot be written", async () => {
    await mkdir(join(dataDir, "aleph-update", "audit.jsonl"), {
      recursive: true,
    });
    await expect(compose().start(UPDATE)).rejects.toMatchObject({
      status: 503,
    });
  });
});
