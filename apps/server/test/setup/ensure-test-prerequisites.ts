import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface GeneratedPrerequisite {
  readonly label: string;
  readonly packageDir: string;
  readonly script: string;
  readonly outputs: readonly string[];
}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export const GENERATED_PREREQUISITES: readonly GeneratedPrerequisite[] = [
  {
    label: "@bb/process-utils profile worker",
    packageDir: "packages/process-utils",
    script: "scripts/generate-profile-worker.mjs",
    outputs: ["src/generated/profile-worker.ts"],
  },
  {
    label: "@get-bb/plugin-sdk runtime",
    packageDir: "packages/plugin-sdk",
    script: "scripts/build-runtime.mjs",
    outputs: ["dist/index.js", "dist/host.js", "dist/provider-bridge-acp.js"],
  },
];

export function missingPrerequisites(
  prerequisites: readonly GeneratedPrerequisite[],
  root: string,
): GeneratedPrerequisite[] {
  return prerequisites.filter((prerequisite) =>
    prerequisite.outputs.some(
      (output) => !existsSync(`${root}/${prerequisite.packageDir}/${output}`),
    ),
  );
}

export default async function ensureTestPrerequisites(): Promise<void> {
  for (const prerequisite of missingPrerequisites(
    GENERATED_PREREQUISITES,
    repoRoot,
  )) {
    try {
      await execFileAsync(process.execPath, [prerequisite.script], {
        cwd: `${repoRoot}${prerequisite.packageDir}`,
      });
    } catch (error) {
      throw new Error(
        `Could not build ${prerequisite.label} before the server tests: ${String(error)}`,
        { cause: error },
      );
    }
  }
}
