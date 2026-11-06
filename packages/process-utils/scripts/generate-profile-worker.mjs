import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { writeFileAtomically } from "./write-file-atomically.mjs";

const result = await build({
  entryPoints: [
    fileURLToPath(new URL("../src/profile-worker.ts", import.meta.url)),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  write: false,
});
await writeFileAtomically(
  fileURLToPath(new URL("../src/generated/profile-worker.ts", import.meta.url)),
  `export const profileWorkerSource = ${JSON.stringify(result.outputFiles[0].text)};\n`,
);
