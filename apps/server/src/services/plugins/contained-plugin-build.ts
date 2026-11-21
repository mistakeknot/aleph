import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { pluginInstallBuildWorkerSource } from "../../generated/plugin-install-build-worker.js";
import { runInstallCommand } from "./install-sources.js";
import type { buildCachedPluginServer } from "./plugin-server-cache.js";
import { currentInstallContainment } from "./install-containment.js";

type CachedBuildRequest = Omit<
  Parameters<typeof buildCachedPluginServer>[0],
  "toolchain" | "fallbackResolve"
> & { resolutionBase: string };
type BuildRequest = {
  rootDir: string;
  dataDir: string;
  version: string;
  app: boolean;
  server: boolean;
  host: boolean;
  cached?: CachedBuildRequest;
};

export async function runContainedPluginBuild(
  args: BuildRequest,
): Promise<string[]> {
  if (!args.app && !args.server && !args.host) return [];
  return z.array(z.string()).parse(await runBuildWorker(args));
}

export async function runContainedCachedPluginServer(args: CachedBuildRequest) {
  return z
    .object({
      path: z.string(),
      digest: z.string(),
      warnings: z.array(z.string()),
    })
    .parse(
      await runBuildWorker({
        rootDir: args.rootDir,
        dataDir: args.dataDir,
        version: args.bbVersion,
        app: false,
        server: false,
        host: false,
        cached: args,
      }),
    );
}

async function runBuildWorker(args: BuildRequest): Promise<unknown> {
  const containment = currentInstallContainment();
  if (containment === undefined)
    throw new Error("contained plugin build requires an install containment");
  const digest = createHash("sha256")
    .update(pluginInstallBuildWorkerSource)
    .digest("hex");
  const root = join(args.dataDir, ".plugin-install-workers");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const worker = join(root, `${digest}.mjs`);
  try {
    await writeFile(worker, pluginInstallBuildWorkerSource, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
    if (
      createHash("sha256")
        .update(await readFile(worker))
        .digest("hex") !== digest
    )
      throw new Error("plugin build worker integrity mismatch");
  }
  // The worker bundle treats this as its own module URL: it locates the build
  // toolchain and the build-code digest that is part of the cache key. The
  // cached request's resolutionBase is used only inside the worker's
  // fallbackResolve.
  let pluginBuildBase = import.meta.url;
  try {
    pluginBuildBase = import.meta.resolve("@bb/plugin-build");
  } catch {}
  const output = await runInstallCommand(
    process.execPath,
    [
      "--experimental-import-meta-resolve",
      worker,
      JSON.stringify({ ...args, containmentId: containment.id }),
      pluginBuildBase,
    ],
    { maxStdoutBytes: 1024 * 1024, label: "plugin build worker" },
  );
  const result = output
    .split("\n")
    .reverse()
    .find((line) => line.startsWith("BB_PLUGIN_BUILD_RESULT:"));
  if (result === undefined)
    throw new Error("plugin build worker returned no result");
  return JSON.parse(result.slice("BB_PLUGIN_BUILD_RESULT:".length));
}
