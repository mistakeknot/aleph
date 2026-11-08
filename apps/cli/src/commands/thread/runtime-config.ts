import { Command } from "commander";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { outputJson, requireThreadIdOrSelf } from "../helpers.js";

interface RuntimeConfigOptions {
  dryRun?: boolean;
  json?: boolean;
  self?: boolean;
}

export function registerRuntimeConfigCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("runtime-config [id]")
    .description(
      "Resolve the instructions a thread would start with and print the rules receipt, without starting a session",
    )
    .option("--dry-run", "Resolve only; required")
    .option("--self", "Use the current thread")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: RuntimeConfigOptions) => {
        if (opts.dryRun !== true) {
          throw new Error("thread runtime-config requires --dry-run");
        }
        const threadId = requireThreadIdOrSelf(id, opts);
        const result = await createCliBbSdk(getUrl()).threads.runtimeConfig({
          threadId,
        });
        if (outputJson(opts, result)) return;
        const receipt = result.rulesReceipt;
        console.log(`Source: ${receipt.source}`);
        console.log(`Mode: ${receipt.mode ?? "none"}`);
        console.log(`Snapshot: ${receipt.snapshotId ?? "none"}`);
        console.log(
          `Instructions: ${receipt.instructionsBytes} bytes, sha256 ${receipt.instructionsSha256}`,
        );
        for (const section of receipt.sections) {
          console.log(
            `  ${section.header ?? "(no header)"}: ${section.bytes} bytes, sha256 ${section.sha256}`,
          );
        }
      }),
    );
}
