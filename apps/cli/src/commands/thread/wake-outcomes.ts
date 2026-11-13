import { Command } from "commander";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { outputJson } from "../helpers.js";

export function registerWakeOutcomesCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("wake-outcomes <threadId>")
    .description("Report accepted wake causes and observed turn effects")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (threadId: string, opts: { json?: boolean }) => {
        const report = await createCliBbSdk(
          getUrl(),
        ).threads.experimental_wakeOutcomes({ threadId });
        if (outputJson(opts, report)) return;
        for (const outcome of report.outcomes) {
          console.log(
            `${outcome.turnId}: ${outcome.wakeCause}, tools=${outcome.toolCount ?? "unknown"}, observed change=${outcome.changedAnything}`,
          );
        }
        console.log(`Completed turns: ${report.summary.completedTurns}`);
        if (report.truncated)
          console.log(
            "Report truncated; rates describe only the returned turns.",
          );
      }),
    );
}
