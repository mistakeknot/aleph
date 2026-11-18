// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";
const { flushes } = vi.hoisted(() => ({
  flushes: [] as Array<ReturnType<typeof vi.fn>>,
}));
vi.mock("./description-save.js", () => ({
  createDescriptionSaver: () => {
    const flush = vi.fn();
    flushes.push(flush);
    return { flush, onChange: vi.fn(), hasPending: () => false };
  },
}));
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

const app = await loadPluginApp(() => import("../../app"));

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT5";
const task = makeTask({
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Ship the PR pill",
  position: 1,
});

function detailRpc(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: () => ({
      projects: [
        {
          id: PROJECT_ID,
          name: "Tasks Plugin",
          prefix: "TSK",
          nextTaskNumber: 6,
          color: "blue",
          folderId: null,
          linkedBbProjectId: null,
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      ],
    }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    getTaskByKey: () => ({ task }),
    listTasks: (input: unknown) =>
      input !== null && rpcInput(input).parentTaskId
        ? { tasks: [] }
        : { tasks: [task] },
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({
      taskThreads: [],
    }),
    listTaskPullRequests: () => ({
      pullRequests: [],
      unavailableThreadIds: [],
    }),
    listComments: () => ({ comments: [] }),
    listProgressNotes: () => ({ progressNotes: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
    ...overrides,
  };
}

it("flushes both buffers per lifecycle event and removes listeners on unmount", async () => {
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "task/TSK-5" },
    { rpc: detailRpc(), openUrl: () => true },
  );
  await waitFor(() => expect(flushes.length).toBe(2));
  window.dispatchEvent(new Event("pagehide"));
  for (const flush of flushes) expect(flush).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  for (const flush of flushes) expect(flush).toHaveBeenCalledTimes(2);
  slot.unmount();
  for (const flush of flushes) expect(flush).toHaveBeenCalledTimes(3);
  window.dispatchEvent(new Event("pagehide"));
  document.dispatchEvent(new Event("visibilitychange"));
  for (const flush of flushes) expect(flush).toHaveBeenCalledTimes(3);
});
