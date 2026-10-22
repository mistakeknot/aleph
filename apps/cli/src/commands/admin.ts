import { Command } from "commander";
import type {
  EventArchiveReconcileResponse,
  EventArchiveStatus,
} from "@bb/server-contract";
import { CliUsageError, action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { columnWidths, printBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";

interface JsonOptions {
  json?: boolean;
}

interface RehydrateOptions extends JsonOptions {
  all?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDays(ms: number): string {
  const days = ms / DAY_MS;
  return `${Number.isInteger(days) ? days : days.toFixed(2)}d`;
}

function printArchiveClasses(
  classification: Pick<EventArchiveStatus, "classes">,
): void {
  const rows = Object.entries(classification.classes).map(([name, totals]) => [
    name,
    String(totals.count),
    String(totals.bytes),
  ]);
  printBorderlessTable(
    {
      head: ["Class", "Files", "Bytes"],
      colWidths: columnWidths(rows, [8, 5, 5]),
    },
    rows,
  );
}

function printArchiveProblems(
  classification: Pick<
    EventArchiveStatus,
    "inconsistencies" | "missingLiveSegments"
  >,
): void {
  for (const segmentId of classification.missingLiveSegments) {
    console.log(`Missing live segment file: ${segmentId}`);
  }
  for (const inconsistency of classification.inconsistencies) {
    console.log(
      `Inconsistent: ${inconsistency.segmentId} (${inconsistency.reason})`,
    );
  }
}

function printStatus(status: EventArchiveStatus): void {
  const { config } = status;
  console.log(`Mode: ${config.mode}`);
  console.log(
    `Moves threads archived ${formatDays(config.minArchivedMs)} or longer, up to ${config.maxThreadBytes} bytes${config.maxThreadBytesClamped ? " (clamped)" : ""}; rehydrated threads wait ${formatDays(config.rehotCooldownMs)}`,
  );
  console.log(`Cold threads: ${status.coldThreads}`);
  console.log(
    `Segments: ${Object.entries(status.segments)
      .map(([lifecycle, count]) => `${lifecycle} ${count}`)
      .join(", ")}`,
  );
  console.log(`Queue depth: ${status.queueDepth}`);
  console.log(`zstd: ${status.zstdAvailable ? "available" : "unavailable"}`);
  printArchiveClasses(status);
  printArchiveProblems(status);
}

function printReconcile(result: EventArchiveReconcileResponse): void {
  console.log(`Orphaned segments marked: ${result.orphaned.length}`);
  console.log(`Committed entries repaired: ${result.repairedCommitted.length}`);
  printArchiveClasses(result);
  printArchiveProblems(result);
}

export function registerAdminCommands(
  program: Command,
  getUrl: () => string,
): void {
  const admin = program
    .command("admin")
    .description("Maintain the bb server's stored data");

  const eventArchive = admin
    .command("event-archive")
    .description(
      "Inspect and manage thread history moved out of the database into the event archive",
    );

  eventArchive
    .command("status", { isDefault: true })
    .description(
      "Show the archive's mode, cold threads, segments, and files by class",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const status =
          await createCliBbSdk(
            getUrl(),
          ).system.experimental_eventArchiveStatus();
        if (outputJson(opts, status)) return;
        printStatus(status);
      }),
    );

  eventArchive
    .command("rehydrate [threadId]")
    .description(
      "Move a thread's archived history back into the database, or every cold thread with --all",
    )
    .option("--all", "Rehydrate every cold thread")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (threadId: string | undefined, opts: RehydrateOptions) => {
        if (opts.all === true && threadId !== undefined) {
          throw new CliUsageError({
            code: "invalid_arguments",
            hint: null,
            message: "Pass a thread id or --all, not both.",
          });
        }
        if (opts.all !== true && threadId === undefined) {
          throw new CliUsageError({
            code: "missing_argument",
            hint: null,
            message: "Pass a thread id, or --all for every cold thread.",
          });
        }
        const result = await createCliBbSdk(
          getUrl(),
        ).system.experimental_eventArchiveRehydrate(
          opts.all === true ? { all: true } : { threadId: threadId! },
        );
        if (outputJson(opts, result)) return;
        if (result.scope === "thread") {
          console.log(
            result.result.outcome === "rehydrated"
              ? `Rehydrated ${result.result.rowCount} events for ${result.result.threadId}.`
              : `${result.result.threadId} is already in the database.`,
          );
          return;
        }
        console.log(`Rehydrated ${result.rehydrated} threads.`);
        for (const failure of result.failed) {
          console.log(`Failed ${failure.threadId}: ${failure.error}`);
        }
        if (result.failed.length > 0) {
          process.exitCode = 1;
        }
      }),
    );

  eventArchive
    .command("reconcile")
    .description(
      "Mark orphaned segments, repair missing manifest commits, and report files by class",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const result =
          await createCliBbSdk(
            getUrl(),
          ).system.experimental_eventArchiveReconcile();
        if (outputJson(opts, result)) return;
        printReconcile(result);
      }),
    );
}
