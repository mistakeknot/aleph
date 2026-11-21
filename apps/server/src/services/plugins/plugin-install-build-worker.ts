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
console.log(`BB_PLUGIN_BUILD_RESULT:${JSON.stringify(warnings)}`);
