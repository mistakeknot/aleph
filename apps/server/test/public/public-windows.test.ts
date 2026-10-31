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
      const presets = body.preferences["windows.presets"]?.value as unknown as {
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

  it("refuses direct writes to window preferences", async () => {
    await withTestHarness(async (harness) => {
      for (const key of ["windows.presets", "windows.suggestions"]) {
        const put = await send(harness, "PUT", `/preferences/ui/${key}`, {
          value: key === "windows.presets" ? [] : {},
          expectedRevision: 0,
        });
        expect(put.status).toBe(403);
        expect(
          (await send(harness, "DELETE", `/preferences/ui/${key}`)).status,
        ).toBe(403);
      }
    });
  });

  it("applies a suggestion only through accept from a reporting window", async () => {
    await withTestHarness(async (harness) => {
      const panes = [{ kind: "thread", projectId: "prj_1", threadId: "thr_9" }];
      await send(harness, "PUT", "/windows/presets/priorities/suggestion", {
        panes,
        proposedBy: "thr_x",
      });
      const proposedAt = async () =>
        (
          (await readJson(await send(harness, "GET", "/preferences/ui"))) as {
            preferences: Record<string, { value: unknown }>;
          }
        ).preferences["windows.suggestions"]?.value as Record<
          string,
          { proposedAt: string }
        >;
      const accept = async (windowId: string, at?: string) =>
        send(harness, "POST", "/windows/presets/priorities/suggestion/accept", {
          windowId,
          proposedAt: at ?? (await proposedAt())["priorities"]?.proposedAt,
        });
      expect((await accept("w1")).status).toBe(404);
      await send(harness, "POST", "/windows/report", {
        ...reportBody("w1"),
        presetId: "priorities",
      });
      expect((await accept("w1", "stale")).status).toBe(409);
      expect((await accept("w1")).status).toBe(200);
      const body = (await readJson(
        await send(harness, "GET", "/preferences/ui"),
      )) as { preferences: Record<string, { value: unknown }> };
      const presets = body.preferences["windows.presets"]?.value as {
        id: string;
        panes: unknown[];
      }[];
      expect(presets.find((p) => p.id === "priorities")?.panes).toEqual(panes);
      expect(body.preferences["windows.suggestions"]?.value).toEqual({});
      expect((await accept("w1", "x")).status).toBe(404);
    });
  });

  it("dismisses a suggestion", async () => {
    await withTestHarness(async (harness) => {
      await send(harness, "PUT", "/windows/presets/priorities/suggestion", {
        panes: [],
        proposedBy: "thr_x",
      });
      const before = (await readJson(
        await send(harness, "GET", "/preferences/ui"),
      )) as { preferences: Record<string, { value: unknown }> };
      const at = (
        before.preferences["windows.suggestions"]?.value as Record<
          string,
          { proposedAt: string }
        >
      )["priorities"]?.proposedAt;
      const dismiss = (proposedAt: string | undefined) =>
        send(
          harness,
          "POST",
          "/windows/presets/priorities/suggestion/dismiss",
          { proposedAt },
        );
      expect((await dismiss("stale")).status).toBe(409);
      expect((await dismiss(at)).status).toBe(200);
      const body = (await readJson(
        await send(harness, "GET", "/preferences/ui"),
      )) as { preferences: Record<string, { value: unknown }> };
      expect(body.preferences["windows.suggestions"]?.value).toEqual({});
    });
  });

  it("gives a replacement suggestion a different identity even at the same instant", async () => {
    await withTestHarness(async (harness) => {
      const propose = async () =>
        (await readJson(
          await send(harness, "PUT", "/windows/presets/priorities/suggestion", {
            panes: [],
            proposedBy: "thr_x",
          }),
        )) as { suggestion: { proposedAt: string } };
      const first = (await propose()).suggestion.proposedAt;
      const second = (await propose()).suggestion.proposedAt;
      expect(second).not.toBe(first);
    });
  });
});
