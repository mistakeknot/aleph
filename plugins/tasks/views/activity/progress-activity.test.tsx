// @vitest-environment jsdom
import { cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DisplayComment } from "../../shared/contract.js";
import { makeTask, rpcInput } from "../../test-fixtures.js";

vi.mock("../../editor/tasks-editor.js", () => ({
  TasksEditor: (props: { value: string }) => <p>{props.value}</p>,
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
const { activityTimeline } = await import("./task-activity.js");

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT5";

const task = makeTask({
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Show quiet progress",
  position: 1,
});

function comment(
  suffix: string,
  kind: DisplayComment["kind"],
  createdAt: string,
  body: string,
): DisplayComment {
  const agent = kind === "agent";
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZZC${suffix}`,
    taskId: TASK_ID,
    kind,
    authorName: agent ? "Worker" : "You",
    presetName: null,
    threadId: agent ? "thr_worker000" : null,
    threadTitle: agent ? "Worker thread" : null,
    body,
    notifiedCount: 0,
    createdAt,
    provider: null,
  };
}

function note(
  suffix: string,
  createdAt: string,
  body: string,
  proofUrl: string | null,
  threadId: string | null = "thr_other0000",
) {
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZZN${suffix}`,
    taskId: TASK_ID,
    authorName: "agent (thr_other0000)",
    presetName: null,
    threadId,
    body,
    proofUrl,
    createdAt,
  };
}

const comments = [
  comment("1", "user", "2026-07-15T10:00:00.000Z", "First comment"),
  comment("2", "agent", "2026-07-15T10:10:00.000Z", "Agent reply"),
];
const progressNotes = [
  note(
    "1",
    "2026-07-15T10:05:00.000Z",
    "Quiet note with proof",
    "https://example.test/runs/7",
  ),
  note("2", "2026-07-15T10:10:00.000Z", "Tie note", null),
  note("3", "2026-07-15T10:20:00.000Z", "Late quiet note", null),
];

function detailRpc() {
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
    listTaskThreads: () => ({ taskThreads: [] }),
    listTaskPullRequests: () => ({
      pullRequests: [],
      unavailableThreadIds: [],
    }),
    listComments: () => ({ comments }),
    listProgressNotes: () => ({ progressNotes }),
    listBbProjects: () => ({ bbProjects: [] }),
  };
}

describe("activity timeline merge", () => {
  it("orders comments and notes by time, comments first on ties", () => {
    const timeline = activityTimeline(
      comments.map((entry) => ({ comment: entry, attachments: [] })),
      progressNotes,
    );
    expect(
      timeline.map((entry) =>
        entry.type === "comment" ? entry.entry.comment.body : entry.note.body,
      ),
    ).toEqual([
      "First comment",
      "Quiet note with proof",
      "Agent reply",
      "Tie note",
      "Late quiet note",
    ]);
  });
});

describe("task detail activity with progress notes", () => {
  it("merges notes chronologically, marks them Progress and links proof", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { openUrl: () => true, rpc: detailRpc() },
    );
    const section = within(
      await slot.findByRole("region", { name: "Activity" }),
    );
    await section.findByText("Late quiet note");

    const text = (await slot.findByRole("region", { name: "Activity" }))
      .textContent!;
    const order = [
      "First comment",
      "Quiet note with proof",
      "Agent reply",
      "Tie note",
      "Late quiet note",
    ].map((body) => text.indexOf(body));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));

    expect(section.getAllByText("Progress")).toHaveLength(3);

    const link = section.getByRole("link", {
      name: "https://example.test/runs/7",
    }) as HTMLAnchorElement;
    expect(link.href).toBe("https://example.test/runs/7");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(section.getAllByRole("link")).toHaveLength(1);
  });

  it("keeps the notify control on the latest agent comment, not a progress writer", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { openUrl: () => true, rpc: detailRpc() },
    );
    expect(
      await slot.findByRole("switch", { name: "Notify Worker thread" }),
    ).toBeTruthy();
  });
});
