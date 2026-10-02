import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import type { ThreadSearchResponse } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { buildPaletteThreadSearchRows } from "./palette-thread-search";

const NOW = 1_000_000;

function makeThread(
  id: string,
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return {
    id,
    projectId: "project-1",
    environmentId: null,
    providerId: "codex",
    title: `Title ${id}`,
    titleFallback: `Fallback ${id}`,
    sectionId: null,
    status: "idle",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    promptCacheTtl: null,
    visibility: "visible",
    archivedAt: null,
    pinnedAt: null,
    pinSortKey: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: NOW,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentIsWorktree: null,
    environmentName: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "other",
    runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    queuedWork: "none",
    ...overrides,
  };
}

function build(
  overrides: Partial<Parameters<typeof buildPaletteThreadSearchRows>[0]> = {},
) {
  return buildPaletteThreadSearchRows({
    lifecycles: ["active"],
    now: NOW,
    projectNamesById: new Map([["project-1", "Palette project"]]),
    query: "match",
    recentThreads: [],
    searchResponse: {
      active: { results: [], total: 0 },
      archived: { results: [], total: 0 },
    },
    searchResultsAreCurrent: true,
    ...overrides,
  });
}

describe("buildPaletteThreadSearchRows", () => {
  it("orders archived recents by archive time instead of last update", () => {
    const result = build({
      query: "",
      lifecycles: ["archived"],
      recentThreads: [
        makeThread("updated-latest", { archivedAt: 1, updatedAt: NOW }),
        makeThread("archived-latest", { archivedAt: 2, updatedAt: 1 }),
      ],
    });
    expect(result.rows.map((row) => row.threadId)).toEqual([
      "archived-latest",
      "updated-latest",
    ]);
  });

  it("keeps saved-message threads in Active recents", () => {
    const saved = makeThread("saved", { status: "pending", updatedAt: NOW });
    const archived = makeThread("archived", { archivedAt: 1, updatedAt: 2 });
    const active = Array.from({ length: 25 }, (_, index) =>
      makeThread(`active-${index}`, { updatedAt: 1 }),
    );
    const recentThreads = [...active, saved, archived];
    const result = build({
      query: "",
      recentThreads,
      lifecycles: ["active", "archived"],
    });
    expect(result.rows).toHaveLength(21);
    expect(result.rows[0]).toMatchObject({
      threadId: "saved",
      lifecycle: "active",
    });
    expect(result.rows[20]).toMatchObject({
      threadId: "archived",
      lifecycle: "archived",
    });
  });

  it("keeps saved-message snippets in the owning thread result", () => {
    const result = build({
      lifecycles: ["active"],
      searchResponse: {
        active: {
          total: 1,
          results: [
            {
              thread: makeThread("saved", { status: "pending" }),
              matches: [
                {
                  sourceKind: "user_message",
                  text: "matching saved message",
                  highlightRanges: [{ start: 0, end: 5 }],
                  sourceSeq: null,
                },
              ],
            },
          ],
        },
        archived: { total: 0, results: [] },
      },
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      threadId: "saved",
      lifecycle: "active",
      primaryText: "matching saved message",
    });
  });

  it("preserves active and archived server matches in their ranked order", () => {
    const active = makeThread("active");
    const archived = makeThread("archived", { archivedAt: NOW - 1 });
    const searchResponse: ThreadSearchResponse = {
      active: {
        total: 1,
        results: [{ thread: active, matches: [] }],
      },
      archived: {
        total: 1,
        results: [{ thread: archived, matches: [] }],
      },
    };

    const result = build({
      lifecycles: ["active", "archived"],
      searchResponse,
    });

    expect(result.rows.map((row) => row.lifecycle)).toEqual([
      "active",
      "archived",
    ]);
    expect(result.rows.map((row) => row.thread)).toEqual([active, archived]);
    expect(result.rows.map((row) => row.projectName)).toEqual([
      "Palette project",
      "Palette project",
    ]);
    expect(result.rows.map((row) => row.threadId)).toEqual([
      "active",
      "archived",
    ]);
  });

  it("uses the matched message as primary while retaining title, project, and time metadata", () => {
    const thread = makeThread("message", { title: "Original title" });
    const result = build({
      searchResponse: {
        active: {
          total: 1,
          results: [
            {
              thread,
              matches: [
                {
                  sourceKind: "user_message",
                  text: "the matching message",
                  highlightRanges: [{ start: 4, end: 12 }],
                  sourceSeq: 42,
                },
              ],
            },
          ],
        },
        archived: { results: [], total: 0 },
      },
    });

    expect(result.rows[0]).toMatchObject({
      primaryText: "the matching message",
      secondaryTitle: "Original title",
      projectName: "Palette project",
      relativeTime: "just now",
      highlightRanges: [{ start: 4, end: 12 }],
    });
  });

  it("shows a title match as its title even when a message also matched", () => {
    const thread = makeThread("vizier", {
      title: "Masaq' | vizier",
      titleFallback: "Can we have this thread be the vizier thread",
    });
    const result = build({
      query: "masaq",
      searchResponse: {
        active: {
          total: 1,
          results: [
            {
              thread,
              matches: [
                {
                  sourceKind: "title",
                  text: "Masaq' | vizier",
                  highlightRanges: [{ start: 0, end: 5 }],
                  sourceSeq: null,
                },
                {
                  sourceKind: "assistant_message",
                  text: "tell the masaq vizier",
                  highlightRanges: [{ start: 9, end: 14 }],
                  sourceSeq: 7,
                },
              ],
            },
          ],
        },
        archived: { results: [], total: 0 },
      },
    });

    expect(result.rows[0]).toMatchObject({
      primaryText: "Masaq' | vizier",
      highlightRanges: [{ start: 0, end: 5 }],
      secondaryTitle: null,
    });
  });

  it("uses active recents before typing and does not reuse them for a one-character query", () => {
    const active = makeThread("recent-active");
    const archived = makeThread("recent-archived", { archivedAt: NOW - 1 });
    const recents = build({
      query: "",
      searchResponse: {
        active: { total: 0, results: [] },
        archived: { total: 1, results: [{ thread: archived, matches: [] }] },
      },
      recentThreads: [active],
    });
    expect(recents).toMatchObject({
      isRecent: true,
      rows: [{ id: "active:recent-active" }],
    });
    expect(build({ query: "m", recentThreads: [active] })).toMatchObject({
      isRecent: false,
      rows: [],
    });
  });
  it("does not show stale server matches while a new query is debouncing", () => {
    const thread = makeThread("stale");
    expect(
      build({
        searchResultsAreCurrent: false,
        searchResponse: {
          active: { total: 1, results: [{ thread, matches: [] }] },
          archived: { total: 1, results: [{ thread, matches: [] }] },
        },
      }).rows,
    ).toEqual([]);
  });
  it("omits project metadata for personal or unresolved projects", () => {
    const result = build({
      query: "",
      recentThreads: [
        makeThread("personal", { projectId: PERSONAL_PROJECT_ID }),
        makeThread("unresolved", { projectId: "unknown-project" }),
      ],
    });
    expect(result.rows.map((row) => row.projectName)).toEqual([null, null]);
  });
  it("orders active recents by update time across projects when nothing is pinned", () => {
    const older = makeThread("older", { updatedAt: NOW - 100 });
    const newest = makeThread("newest", {
      projectId: "project-2",
      updatedAt: NOW,
    });
    const tied = makeThread("tied", { updatedAt: NOW });
    expect(
      build({ query: "", recentThreads: [older, newest, tied] }).rows.map(
        (row) => row.id,
      ),
    ).toEqual(["active:newest", "active:tied", "active:older"]);
  });

  it("floats pinned recents to the top ahead of update-time ordering, preserving order within each tier", () => {
    const older = makeThread("older", { updatedAt: NOW - 100, pinnedAt: NOW });
    const newest = makeThread("newest", {
      projectId: "project-2",
      updatedAt: NOW,
    });
    const tied = makeThread("tied", { updatedAt: NOW });
    const anotherPinned = makeThread("another-pinned", {
      updatedAt: NOW - 50,
      pinnedAt: NOW - 1,
    });
    expect(
      build({
        query: "",
        recentThreads: [older, newest, tied, anotherPinned],
      }).rows.map((row) => row.id),
    ).toEqual([
      "active:another-pinned",
      "active:older",
      "active:newest",
      "active:tied",
    ]);
  });

  it("chooses the newest threads before applying the recent limit", () => {
    const recentThreads = Array.from({ length: 21 }, (_, index) =>
      makeThread(String(index), { updatedAt: NOW + index }),
    );
    const rows = build({ query: "", recentThreads }).rows;
    expect(rows).toHaveLength(20);
    expect(rows[0]?.threadId).toBe("20");
    expect(rows.at(-1)?.threadId).toBe("1");
    expect(recentThreads[0]?.id).toBe("0");
  });

  it("does not pull an ancient pinned thread into the capped recent-thread window", () => {
    const ancientPinned = makeThread("ancient-pinned", {
      updatedAt: NOW - 10_000,
      pinnedAt: NOW - 10_000,
    });
    const recentThreads = [
      ancientPinned,
      ...Array.from({ length: 20 }, (_, index) =>
        makeThread(`recent-${index}`, { updatedAt: NOW + index }),
      ),
    ];
    const rows = build({ query: "", recentThreads }).rows;
    expect(rows).toHaveLength(20);
    expect(rows.map((row) => row.threadId)).not.toContain("ancient-pinned");
  });

  it("does not apply the pinned boost to search results — the server already orders those", () => {
    const pinned = makeThread("pinned", { pinnedAt: NOW });
    const unpinned = makeThread("unpinned");
    const result = build({
      searchResponse: {
        active: {
          total: 2,
          results: [
            { thread: unpinned, matches: [] },
            { thread: pinned, matches: [] },
          ],
        },
        archived: { total: 0, results: [] },
      },
    });
    expect(result.rows.map((row) => row.threadId)).toEqual([
      "unpinned",
      "pinned",
    ]);
  });
});
