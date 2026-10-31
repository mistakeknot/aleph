import { describe, expect, it } from "vitest";
import {
  buildPresetLayout,
  resolvePresetContents,
  type PresetThreadCandidate,
} from "./resolve";

function thread(
  id: string,
  title: string,
  pinnedAt: number | null,
  updatedAt = 1,
): PresetThreadCandidate {
  return {
    id,
    projectId: "p1",
    title,
    titleFallback: null,
    pinnedAt,
    updatedAt,
  };
}

describe("resolvePresetContents", () => {
  it("resolves a pinned title-prefix pane to the pinned thread only", () => {
    const threads = [
      thread("t-unpinned", "Masaq' | vizier old", null, 9),
      thread("t-pinned", "Masaq' | vizier", 5, 1),
    ];
    const contents = resolvePresetContents(
      [
        {
          kind: "thread-title",
          titlePrefix: "Masaq' | vizier",
          pinnedOnly: true,
        },
      ],
      threads,
    );
    expect(contents).toEqual([
      { kind: "thread", projectId: "p1", threadId: "t-pinned" },
    ]);
  });

  it("drops panes whose title matches nothing", () => {
    expect(
      resolvePresetContents(
        [{ kind: "thread-title", titlePrefix: "nope" }],
        [thread("a", "other", null)],
      ),
    ).toEqual([]);
  });

  it("maps plugin panels with an empty sub path", () => {
    expect(
      resolvePresetContents(
        [{ kind: "plugin-panel", pluginId: "autarch", panelPath: "home" }],
        [],
      ),
    ).toEqual([
      {
        kind: "plugin-panel",
        pluginId: "autarch",
        panelPath: "home",
        subPath: "",
      },
    ]);
  });
});

describe("buildPresetLayout", () => {
  it("builds an equal split in the preset direction", () => {
    const layout = buildPresetLayout(
      [
        {
          kind: "plugin-panel",
          pluginId: "autarch",
          panelPath: "home",
          subPath: "",
        },
        { kind: "thread", projectId: "p1", threadId: "t1" },
      ],
      "row",
    );
    expect(layout.root).toMatchObject({
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
    });
    expect(layout.focusedPaneId).toBe("pane-2");
  });

  it("falls back to a single compose pane when empty", () => {
    expect(buildPresetLayout([], "row").root).toMatchObject({
      type: "pane",
      content: { kind: "new-thread" },
    });
  });
});
