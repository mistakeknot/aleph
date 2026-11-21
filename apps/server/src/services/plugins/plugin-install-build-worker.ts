import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildCachedPluginServer } from "./plugin-server-cache.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  buildPluginApp,
  buildPluginServer,
  buildPluginHost,
  resolvePluginBuildToolchain,
} from "@bb/plugin-build";

const input = z
  .object({
    rootDir: z.string(),
    dataDir: z.string(),
    version: z.string(),
    containmentId: z.string(),
    app: z.boolean(),
    server: z.boolean(),
    host: z.boolean(),
    cached: z
      .object({
        rootDir: z.string(),
        dataDir: z.string(),
        pluginId: z.string(),
        sdkVersion: z.string(),
        bbVersion: z.string(),
        resolutionBase: z.string(),
        validatedConfig: z.object({
          serverEntry: z.string(),
          packageName: z.string(),
          pluginVersion: z.string(),
        }),
        runtimeImports: z.record(
          z.string(),
          z.object({ path: z.string(), external: z.boolean().optional() }),
        ),
      })
      .optional(),
  })
  .parse(JSON.parse(process.argv[2] ?? "null"));
if (
  !(await readFile("/proc/self/cgroup", "utf8"))
    .split("/")
    .some((part) => part.trim() === input.containmentId)
)
  throw new Error("plugin build worker is outside its install containment");
const toolchain = await resolvePluginBuildToolchain(
  join(input.dataDir, "plugins"),
);
const warnings: string[] = [];
if (input.app)
  warnings.push(
    ...(
      await buildPluginApp(input.rootDir, input.version, toolchain, {
        minify: true,
        hostProvidedZod: true,
      })
    ).migrationWarnings,
  );
if (input.server)
  warnings.push(
    ...(await buildPluginServer(input.rootDir, input.version, toolchain))
      .migrationWarnings,
  );
if (input.host) await buildPluginHost(input.rootDir, input.version, toolchain);
let result: unknown = warnings;
if (input.cached !== undefined) {
  const cached = input.cached;
  const runtimeRequire = createRequire(cached.resolutionBase);
  result = await buildCachedPluginServer({
    ...cached,
    toolchain: async () => toolchain,
    fallbackResolve: (specifier) => {
      try {
        const resolved = import.meta.resolve(specifier, cached.resolutionBase);
        return resolved.startsWith("file:")
          ? fileURLToPath(resolved)
          : resolved;
      } catch {}
      try {
        return runtimeRequire.resolve(specifier);
      } catch {
        return undefined;
      }
    },
  });
}
console.log(`BB_PLUGIN_BUILD_RESULT:${JSON.stringify(result)}`);
