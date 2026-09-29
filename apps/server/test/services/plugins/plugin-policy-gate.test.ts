import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeDerivedSha256,
  computeMirrorChecksum,
  formatAlephUpdateStatePath,
  formatPluginPolicyFeature,
} from "@bb/config/effective-policy";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger } from "../../helpers/test-app.js";

const logger = testLogger as unknown as Logger;

describe("plugin loader policy gate", () => {
  let db: DbConnection;
  let workDir: string;
  let dataDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-policy-test-"));
    dataDir = join(workDir, "data");
    await mkdir(dataDir, { recursive: true });
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir,
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeFixture(name: string, marker: string): Promise<string> {
    const rootDir = join(workDir, name);
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name,
        version: "0.1.0",
        bb: {
          name: "Policy fixture",
          description: "Policy gate fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      join(rootDir, "server.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport default function plugin() {}\n`,
    );
    return rootDir;
  }

  function writePolicyMirror(disabledFeatures: string[]): void {
    const derived = {
      disabled_features: disabledFeatures,
      floor_seq: 0,
      install_state: "idle",
      notice: null,
      release: null,
      revoked_key_ids: [],
      skip_versions: [],
    };
    const body = {
      derived,
      derived_sha256: computeDerivedSha256(derived),
      epoch: 1,
      head_bytes: "",
      semantic_sha256: "",
      sig_bytes: "",
      signing_key_id: "k",
    };
    writeFileSync(
      formatAlephUpdateStatePath(dataDir),
      JSON.stringify({ ...body, checksum: computeMirrorChecksum(body) }),
    );
  }

  it("does not load a plugin the effective policy disables", async () => {
    const marker = join(workDir, "ran-blocked");
    writePolicyMirror([formatPluginPolicyFeature("policyblocked")]);
    const rootDir = await writeFixture("bb-plugin-policyblocked", marker);
    await service.installPath(rootDir);
    const installed = service
      .list()
      .find((plugin) => plugin.id === "policyblocked");
    expect(installed?.status).toBe("disabled");
    expect(installed?.statusDetail).toContain("Aleph update policy");
    expect(existsSync(marker)).toBe(false);
  });

  it("loads plugins the policy does not name", async () => {
    const marker = join(workDir, "ran-allowed");
    writePolicyMirror([formatPluginPolicyFeature("someone-else")]);
    const rootDir = await writeFixture("bb-plugin-policyallowed", marker);
    await service.installPath(rootDir);
    const installed = service
      .list()
      .find((plugin) => plugin.id === "policyallowed");
    expect(installed?.status).not.toBe("disabled");
    expect(existsSync(marker)).toBe(true);
  });
});
