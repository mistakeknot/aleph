import { describe, expect, it, vi } from "vitest";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import {
  collectLogLines,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import { registerWindowCommands } from "../../commands/window.js";

describe("bb window command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerWindowCommands(program, () => "http://server");

  const snapshot = {
    windowId: "w1",
    presetId: "command",
    route: "/",
    sidebarOpen: false,
    rightPanelOpen: false,
    rightPanelTab: null,
    maximizedPaneId: null,
    panes: [
      {
        paneId: "p1",
        kind: "plugin-panel",
        projectId: null,
        threadId: null,
        threadTitle: null,
        pluginId: "autarch",
        panelPath: "home",
        focused: false,
      },
    ],
    viewport: null,
    reportedAt: "2026-10-31T00:00:00.000Z",
  };

  it("lists open windows as a table", async () => {
    stubServerApi({ "v1.windows.$get": async () => ({ windows: [snapshot] }) });
    await runCommand(["window", "list"], register);
    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("w1");
    expect(output).toContain("plugin-panel autarch/home");
  });

  it("proposes a pane list without applying it", async () => {
    const propose = vi.fn(async () => ({
      presetId: "priorities",
      suggestion: {},
    }));
    stubServerApi({
      "v1.windows.presets.:presetId.suggestion.$put": propose,
    });
    await runCommand(
      [
        "window",
        "propose",
        "priorities",
        "--panel",
        "autarch/home",
        "--reason",
        "x",
        "--by",
        "me",
        "--json",
      ],
      register,
    );
    expect(propose).toHaveBeenCalledWith({
      json: {
        panes: [
          { kind: "plugin-panel", pluginId: "autarch", panelPath: "home" },
        ],
        reason: "x",
        proposedBy: "me",
      },
      param: { presetId: "priorities" },
    });
  });
});
