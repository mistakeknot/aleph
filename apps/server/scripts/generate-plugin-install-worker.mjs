import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const result = await build({
  entryPoints: [
    fileURLToPath(
      new URL(
        "../src/services/plugins/plugin-install-build-worker.ts",
        import.meta.url,
      ),
    ),
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  write: false,
  define: { "import.meta.url": "__workerModuleUrl" },
  banner: {
    js: 'import { createRequire as __workerCreateRequire } from "node:module"; const __workerModuleUrl = process.argv[3]; const require = __workerCreateRequire(__workerModuleUrl);',
  },
  external: ["better-sqlite3"],
});
const output = new URL(
  "../src/generated/plugin-install-build-worker.ts",
  import.meta.url,
);
await mkdir(new URL(".", output), { recursive: true });
await writeFile(
  output,
  `export const pluginInstallBuildWorkerSource = ${JSON.stringify(result.outputFiles[0].text)};\n`,
);
