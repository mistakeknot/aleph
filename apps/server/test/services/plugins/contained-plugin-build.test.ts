import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { resolvePluginBuildToolchain } from "@bb/plugin-build";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runContainedCachedPluginServer } from "../../../src/services/plugins/contained-plugin-build.js";
import { buildCachedPluginServer } from "../../../src/services/plugins/plugin-server-cache.js";

const run = promisify(execFile);

// The worker only checks that its cgroup path contains the containment id, so
// the test process's own innermost cgroup name stands in for a real slice.
const ownCgroupName = async () =>
  (await readFile("/proc/self/cgroup", "utf8"))
    .trim()
    .split("/")
    .filter(Boolean)
    .at(-1)!;

vi.mock("../../../src/services/plugins/install-containment.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/services/plugins/install-containment.js")
  >("../../../src/services/plugins/install-containment.js");
  return {
    ...actual,
    currentInstallContainment: () => ({
      id: process.env.BB_TEST_CONTAINMENT_ID ?? "",
      requestKey: "test",
      server: { pid: process.pid, startTime: "0" },
    }),
  };
});

vi.mock("../../../src/services/plugins/install-sources.js", () => ({
  // Run the worker as a plain child so its cgroup check sees the test's own.
  runInstallCommand: async (command: string, args: string[]) =>
    (await run(command, args, { maxBuffer: 4 * 1024 * 1024 })).stdout,
}));

const buildRecord = z.object({ configKey: z.string() });

describe("contained plugin server build", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("produces the same cache key as the in-process build and reuses its cache", async () => {
    process.env.BB_TEST_CONTAINMENT_ID = await ownCgroupName();
    const workDir = await mkdtemp(join(tmpdir(), "bb-contained-parity-"));
    tempDirs.push(workDir);
    const rootDir = join(workDir, "plugin");
    await mkdir(rootDir);
    await writeFile(
      join(rootDir, "package.json"),
      '{"name":"bb-plugin-parity","type":"module"}\n',
    );
    await writeFile(
      join(rootDir, "server.ts"),
      "export default function plugin() {}\n",
    );
    const common = {
      rootDir,
      pluginId: "parity-fixture",
      sdkVersion: "0.4.0",
      bbVersion: "0.9.0",
      validatedConfig: {
        serverEntry: join(rootDir, "server.ts"),
        packageName: "bb-plugin-parity",
        pluginVersion: "1.0.0",
      },
      runtimeImports: {},
    };
    // The runtime passes its own module URL here; it must never change the key.
    const resolutionBase = new URL(
      "../../../src/services/plugins/plugin-runtime.ts",
      import.meta.url,
    ).href;
    const inProcessData = join(workDir, "in-process-data");
    const containedData = join(workDir, "contained-data");

    const inProcess = await buildCachedPluginServer({
      ...common,
      dataDir: inProcessData,
      toolchain: () =>
        resolvePluginBuildToolchain(join(inProcessData, "plugins")),
      fallbackResolve: () => undefined,
    });
    const contained = await runContainedCachedPluginServer({
      ...common,
      dataDir: containedData,
      resolutionBase,
    });

    const keyOf = async (path: string) =>
      buildRecord.parse(
        JSON.parse(await readFile(join(dirname(path), "build.json"), "utf8")),
      ).configKey;
    expect(await keyOf(contained.path)).toBe(await keyOf(inProcess.path));

    // A contained rebuild must hit the entry the in-process build left behind.
    const reused = await runContainedCachedPluginServer({
      ...common,
      dataDir: inProcessData,
      resolutionBase,
    });
    expect(reused.path).toBe(inProcess.path);
    expect(reused.digest).toBe(inProcess.digest);
  });
});
