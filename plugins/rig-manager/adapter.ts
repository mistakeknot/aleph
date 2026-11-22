import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  applyRig,
  diffRig,
  exportRig,
  formatRig,
  loadRig,
  type Result,
} from "@bb/rig";

export interface RigContext {
  file: string;
  target: string;
  agentHome: string;
  sourceRoot: string;
  builtinRoot: string;
}

export function createRigAdapter() {
  const confirmations = new Map<
    string,
    { fingerprint: string; expires: number }
  >();
  function install(input: RigContext) {
    for (const value of [input.file, input.target, input.agentHome]) {
      if (!isAbsolute(value))
        throw new Error("Explicit absolute paths required");
    }
    return {
      dataDir: resolve(input.target),
      agentHome: resolve(input.agentHome),
      rigDir: resolve(input.sourceRoot || dirname(input.file)),
      ...(input.builtinRoot ? { builtinRoot: resolve(input.builtinRoot) } : {}),
    };
  }
  async function safe<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch {
      throw new Error(
        "Rig operation refused or failed; configuration and process output suppressed.",
      );
    }
  }
  async function fingerprint(input: RigContext, result: Result) {
    return createHash("sha256")
      .update(await readFile(input.file))
      .update(JSON.stringify({ input, result }))
      .digest("hex");
  }
  async function dry(input: RigContext) {
    return applyRig(await loadRig(input.file), {
      ...install(input),
      target: resolve(input.target),
      dryRun: true,
    });
  }
  return {
    diff: (input: RigContext) =>
      safe(async () => diffRig(await loadRig(input.file), install(input))),
    export: (input: RigContext & { output: string }) =>
      safe(async () => {
        if (!isAbsolute(input.output))
          throw new Error("Explicit absolute output required");
        const result = await exportRig(install(input));
        await writeFile(input.output, formatRig(result.rig), {
          flag: "wx",
          mode: 0o600,
        });
        return { notices: result.references };
      }),
    plan: (input: RigContext) =>
      safe(async () => {
        const result = await dry(input);
        const confirmation = randomUUID();
        for (const [key, value] of confirmations)
          if (value.expires < Date.now()) confirmations.delete(key);
        if (confirmations.size >= 32)
          confirmations.delete(confirmations.keys().next().value ?? "");
        confirmations.set(confirmation, {
          fingerprint: await fingerprint(input, result),
          expires: Date.now() + 300_000,
        });
        return { ...result, confirmation };
      }),
    async apply(input: RigContext & { confirmation: string }) {
      const { confirmation, ...context } = input;
      const prior = confirmations.get(confirmation);
      confirmations.delete(confirmation);
      if (!prior || prior.expires < Date.now())
        throw new Error(
          "Dry run required; confirmation is missing, expired or already used.",
        );
      const result = await safe(() => dry(context));
      if (
        prior.fingerprint !== (await safe(() => fingerprint(context, result)))
      )
        throw new Error("Rig or plan changed; run dry run again.");
      return safe(async () =>
        applyRig(await loadRig(context.file), {
          ...install(context),
          target: resolve(context.target),
          dryRun: false,
        }),
      );
    },
  };
}
