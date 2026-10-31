import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const reportBody = (windowId: string) => ({
  windowId,
  presetId: "command",
  route: "/",
  sidebarOpen: false,
  rightPanelOpen: false,
  rightPanelTab: null,
  maximizedPaneId: null,
  panes: [
    {
      paneId: "pane-1",
      kind: "thread",
      projectId: "prj_1",
      threadId: "thr_1",
      threadTitle: "Masaq' | vizier",
      pluginId: null,
      panelPath: null,
      focused: true,
    },
  ],
  viewport: { width: 1280, height: 800 },
});

async function send(
  harness: TestAppHarness,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return harness.app.request(`/api/v1${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

describe("public windows", () => {
  it("lists reported windows and replaces a window's report", async () => {
    await withTestHarness(async (harness) => {
      expect(await readJson(await send(harness, "GET", "/windows"))).toEqual({
        windows: [],
      });
      expect(
        (await send(harness, "POST", "/windows/report", reportBody("b")))
          .status,
      ).toBe(200);
      await send(harness, "POST", "/windows/report", reportBody("a"));
      await send(harness, "POST", "/windows/report", {
        ...reportBody("a"),
        sidebarOpen: true,
      });
      const body = (await readJson(await send(harness, "GET", "/windows"))) as {
        windows: { windowId: string; sidebarOpen: boolean }[];
      };
      expect(body.windows.map((w) => [w.windowId, w.sidebarOpen])).toEqual([
        ["a", true],
        ["b", false],
      ]);
    });
  });

  it("rejects a malformed report", async () => {
    await withTestHarness(async (harness) => {
      const response = await send(harness, "POST", "/windows/report", {
        windowId: "a",
      });
      expect(response.status).toBe(400);
    });
  });

  it("ships the Command and Priorities presets by default", async () => {
    await withTestHarness(async (harness) => {
      const body = (await readJson(
        await send(harness, "GET", "/preferences/ui"),
      )) as {
        preferences: Record<string, { value: unknown }>;
      };
      const presets = body.preferences["windows.presets"]?.value as {
        id: string;
      }[];
      expect(presets.map((p) => p.id)).toEqual(["command", "priorities"]);
      expect(body.preferences["windows.suggestions"]?.value).toEqual({});
    });
  });

  it("stores a suggestion without changing the preset's panes", async () => {
    await withTestHarness(async (harness) => {
      const panes = [{ kind: "thread", projectId: "prj_1", threadId: "thr_9" }];
      const response = await send(
        harness,
        "PUT",
        "/windows/presets/priorities/suggestion",
        { panes, reason: "focus", proposedBy: "thr_x" },
      );
      expect(response.status).toBe(200);
      const body = (await readJson(
        await send(harness, "GET", "/preferences/ui"),
      )) as {
        preferences: Record<
          string,
          { value: Record<string, unknown> & { panes?: unknown }[] }
        >;
      };
      const suggestions = body.preferences["windows.suggestions"]
        ?.value as unknown as Record<
        string,
        { panes: unknown; proposedBy: string }
      >;
      expect(suggestions["priorities"]).toMatchObject({
        panes,
        proposedBy: "thr_x",
      });
      const presets = body.preferences["windows.presets"]?.value as {
        id: string;
        panes: unknown[];
      }[];
      expect(presets.find((p) => p.id === "priorities")?.panes).toEqual([]);
    });
  });

  it("refuses unknown and fixed presets", async () => {
    await withTestHarness(async (harness) => {
      const panes: unknown[] = [];
      expect(
        (
          await send(harness, "PUT", "/windows/presets/nope/suggestion", {
            panes,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await send(harness, "PUT", "/windows/presets/command/suggestion", {
            panes,
          })
        ).status,
      ).toBe(400);
    });
  });
});
