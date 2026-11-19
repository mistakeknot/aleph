#!/usr/bin/env -S node --import tsx
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  applyRig,
  diffRig,
  exportRig,
  formatRig,
  loadRig,
  schemaJson,
} from "./index.js";

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: "string" },
      "data-dir": { type: "string" },
      "agent-home": { type: "string" },
      "source-root": { type: "string" },
      "builtin-root": { type: "string" },
      output: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "rig export --data-dir DIR --agent-home HOME --output FILE\nrig diff FILE --data-dir DIR --agent-home HOME\nrig apply FILE --target DIR [--dry-run] [--source-root DIR] [--builtin-root DIR]\nrig schema --output FILE\nApply is offline and confines provider homes and writes to the named target. References are never resolved.",
    );
    return 0;
  }
  const [command, file, ...extra] = positionals;
  if (extra.length) throw new Error("Unexpected positional arguments");
  if (command === "schema") {
    if (!values.output) throw new Error("Schema requires --output");
    await writeFile(
      values.output,
      JSON.stringify(schemaJson(), null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return 0;
  }
  if (command === "export") {
    if (!values["data-dir"] || !values.output || !values["agent-home"])
      throw new Error("Export requires --data-dir, --agent-home and --output");
    const result = await exportRig({
      dataDir: resolve(values["data-dir"]),
      agentHome: resolve(values["agent-home"]),
      rigDir: values["source-root"]
        ? resolve(values["source-root"])
        : dirname(resolve(values.output)),
    });
    await writeFile(values.output, formatRig(result.rig), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(`Exported rig; ${result.references.length} named references`);
    for (const reference of result.references)
      console.log(`reference ${reference}`);
    return 0;
  }
  if ((command !== "apply" && command !== "diff") || !file)
    throw new Error("Use rig --help");
  const rig = await loadRig(file);
  const dataDir = command === "apply" ? values.target : values["data-dir"];
  if (!dataDir) throw new Error("Explicit target/data directory required");
  if (
    command === "apply" &&
    values["data-dir"] &&
    resolve(values["data-dir"]) !== resolve(dataDir)
  )
    throw new Error("Named target mismatch");
  const install = {
    dataDir: resolve(dataDir),
    agentHome: resolve(
      values["agent-home"] ??
        (command === "apply" ? join(dataDir, "rig-home") : homedir()),
    ),
    rigDir: resolve(values["source-root"] ?? dirname(file)),
    ...(values["builtin-root"]
      ? { builtinRoot: resolve(values["builtin-root"]) }
      : {}),
  };
  const result =
    command === "apply"
      ? await applyRig(rig, {
          ...install,
          target: resolve(dataDir),
          dryRun: values["dry-run"],
        })
      : await diffRig(rig, install);
  for (const change of result.changes)
    console.log(`${change.section} ${change.kind} ${change.entry}`);
  for (const unsupported of result.unsupported)
    console.log(`unsupported: ${unsupported}`);
  if (!result.changes.length) console.log("No changes");
  return command === "diff" && result.changes.length ? 1 : 0;
}
try {
  process.exitCode = await main();
} catch {
  console.error(
    "rig: operation refused or failed; configuration and process output suppressed. See rig --help.",
  );
  process.exitCode = 2;
}
