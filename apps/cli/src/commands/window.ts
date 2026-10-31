import { Command } from "commander";
import type {
  WindowPresetPane,
  WindowReport,
  WindowSnapshot,
} from "@bb/domain";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { columnWidths, printBorderlessTable, truncateCell } from "../table.js";
import { collectOption, outputJson } from "./helpers.js";

interface JsonOptions {
  json?: boolean;
}

interface ProposeOptions extends JsonOptions {
  thread: string[];
  panel: string[];
  reason?: string;
  by?: string;
}

function describePane(pane: WindowReport["panes"][number]): string {
  switch (pane.kind) {
    case "thread":
      return `thread ${pane.threadId ?? "?"} "${pane.threadTitle ?? ""}"`;
    case "new-thread":
      return "new thread";
    case "plugin-panel":
    case "plugin-detail":
      return `${pane.kind} ${pane.pluginId ?? "?"}/${pane.panelPath ?? "?"}`;
  }
}

function describePresetPane(pane: WindowPresetPane): string {
  switch (pane.kind) {
    case "thread":
      return `thread ${pane.threadId}`;
    case "thread-title":
      return `thread titled "${pane.titlePrefix}"${pane.pinnedOnly ? " (pinned)" : ""}`;
    case "plugin-panel":
      return `panel ${pane.pluginId}/${pane.panelPath}`;
  }
}

function printWindowsTable(windows: WindowSnapshot[]): void {
  const rows = windows.map((window) => [
    window.windowId,
    window.presetId ?? "-",
    window.sidebarOpen ? "sidebar" : "no-sidebar",
    truncateCell(window.panes.map(describePane).join("; ") || "(empty)", 100),
    window.reportedAt,
  ]);
  printBorderlessTable(
    {
      head: ["Window", "Preset", "Sidebar", "Panes", "Reported"],
      colWidths: columnWidths(rows, [6, 6, 7, 5, 8]),
      trimTrailingWhitespace: true,
    },
    rows,
  );
}

function parsePanelSpec(spec: string): WindowPresetPane {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`Invalid --panel '${spec}'. Use <pluginId>/<panelPath>.`);
  }
  return {
    kind: "plugin-panel",
    pluginId: spec.slice(0, slash),
    panelPath: spec.slice(slash + 1),
  };
}

export function registerWindowCommands(
  program: Command,
  getUrl: () => string,
): void {
  const windowCommand = program
    .command("window")
    .description("Inspect open Aleph windows and propose preset changes");

  windowCommand
    .command("list")
    .description("List the windows that are open now and what each shows")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const result = await createCliBbSdk(getUrl()).system.windows.list();
        if (outputJson(opts, result)) return;
        if (result.windows.length === 0) {
          console.log("No windows have reported in the last 90 seconds");
          return;
        }
        printWindowsTable(result.windows);
      }),
    );

  windowCommand
    .command("show <windowId>")
    .description("Show one open window's layout in full")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (windowId: string, opts: JsonOptions) => {
        const { windows } =
          await createCliBbSdk(getUrl()).system.windows.list();
        const window = windows.find(
          (candidate) => candidate.windowId === windowId,
        );
        if (!window) {
          throw new Error(`No open window '${windowId}'. Run bb window list.`);
        }
        if (outputJson(opts, window)) return;
        console.log(
          `Window ${window.windowId} (preset ${window.presetId ?? "none"})`,
        );
        console.log(`Route: ${window.route}`);
        console.log(
          `Sidebar: ${window.sidebarOpen ? "open" : "hidden"}; right panel: ${window.rightPanelOpen ? (window.rightPanelTab ?? "open") : "closed"}`,
        );
        for (const pane of window.panes) {
          console.log(`- ${pane.focused ? "* " : ""}${describePane(pane)}`);
        }
      }),
    );

  const preset = windowCommand
    .command("preset")
    .description("Window presets and pending suggestions");

  preset
    .command("list")
    .description("List presets, their panes and any pending suggestion")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const { preferences } =
          await createCliBbSdk(getUrl()).system.uiPreferences.list();
        const presets = preferences["windows.presets"].value;
        const suggestions = preferences["windows.suggestions"].value;
        const result = presets.map((entry) => ({
          ...entry,
          suggestion: suggestions[entry.id] ?? null,
        }));
        if (outputJson(opts, result)) return;
        for (const entry of result) {
          console.log(
            `${entry.id} (${entry.name})${entry.userEditable ? "" : " fixed layout"}`,
          );
          console.log(
            `  panes: ${entry.panes.map(describePresetPane).join("; ") || "(none)"}`,
          );
          if (entry.suggestion) {
            console.log(
              `  suggested by ${entry.suggestion.proposedBy}: ${entry.suggestion.panes.map(describePresetPane).join("; ") || "(none)"}`,
            );
          }
        }
      }),
    );

  windowCommand
    .command("propose <presetId>")
    .description(
      "Suggest a new pane list for a preset; the user applies it from the window",
    )
    .option(
      "--thread <threadId>",
      "Thread to include (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--panel <pluginId/panelPath>",
      "Plugin panel to include (repeatable)",
      collectOption,
      [],
    )
    .option("--reason <text>", "Why this list is suggested")
    .option("--by <name>", "Who is proposing (defaults to this thread)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (presetId: string, opts: ProposeOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const panes: WindowPresetPane[] = [];
        for (const threadId of opts.thread) {
          const thread = await sdk.threads.get({ threadId });
          panes.push({ kind: "thread", projectId: thread.projectId, threadId });
        }
        for (const spec of opts.panel) panes.push(parsePanelSpec(spec));
        const result = await sdk.system.windows.propose({
          presetId,
          panes,
          reason: opts.reason ?? null,
          proposedBy: opts.by ?? process.env["BB_THREAD_ID"] ?? "agent",
        });
        if (outputJson(opts, result)) return;
        console.log(
          `Suggested ${panes.length} pane(s) for ${presetId}. The window shows an "Update to suggested" prompt; nothing changes until the user accepts it.`,
        );
      }),
    );
}
