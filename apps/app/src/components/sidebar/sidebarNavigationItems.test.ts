import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import { mergePluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import type { PluginNavPanelSlot } from "@/lib/plugin-slots";
import {
  createSidebarNavigationRows,
  isSameSidebarNavigationItem,
  toSidebarNavigationItem,
  type SidebarNavigationItem,
} from "./sidebarNavigationItems";

const Badge: ComponentType = () => null;
const OtherBadge: ComponentType = () => null;

function panel(overrides: Partial<PluginNavPanelSlot> = {}) {
  return {
    pluginId: "garden",
    generation: 1,
    id: "docs",
    title: "Docs",
    icon: "BookOpen",
    path: "docs",
    component: () => null,
    ...overrides,
  } satisfies PluginNavPanelSlot;
}

function itemFor(
  entry: PluginNavPanelSlot,
  remembered: Parameters<typeof mergePluginNavPanelChrome>[0] = [],
): SidebarNavigationItem {
  const row = createSidebarNavigationRows(
    mergePluginNavPanelChrome(remembered, [entry]),
  ).find((candidate) => candidate.id === entry.id);
  if (!row) throw new Error("Expected a navigation row");
  return toSidebarNavigationItem(row, {
    isDisabled: false,
    isVisible: true,
    shortcut: null,
  });
}

describe("toSidebarNavigationItem icon badge", () => {
  it("carries the panel's icon badge component with its owner", () => {
    const item = itemFor(panel({ experimental_sidebarIconBadge: Badge }));

    expect(item.iconBadge).toEqual({
      pluginId: "garden",
      panelId: "docs",
      generation: 1,
      component: Badge,
    });
  });

  it("has no icon badge when the panel registers none", () => {
    expect(itemFor(panel()).iconBadge).toBeNull();
  });

  it("has no icon badge while only remembered chrome is known", () => {
    const remembered = [
      {
        pluginId: "garden",
        id: "docs",
        path: "docs",
        title: "Docs",
        icon: "BookOpen",
      },
    ];
    const row = createSidebarNavigationRows(
      mergePluginNavPanelChrome(remembered, []),
    ).find((candidate) => candidate.id === "docs");
    if (!row) throw new Error("Expected a navigation row");

    expect(
      toSidebarNavigationItem(row, {
        isDisabled: false,
        isVisible: true,
        shortcut: null,
      }).iconBadge,
    ).toBeNull();
  });
});

describe("isSameSidebarNavigationItem icon badge", () => {
  it("treats a swapped badge component or a new generation as a change", () => {
    const base = itemFor(panel({ experimental_sidebarIconBadge: Badge }));

    expect(isSameSidebarNavigationItem(base, { ...base })).toBe(true);
    expect(
      isSameSidebarNavigationItem(
        base,
        itemFor(panel({ experimental_sidebarIconBadge: OtherBadge })),
      ),
    ).toBe(false);
    expect(
      isSameSidebarNavigationItem(
        base,
        itemFor(panel({ experimental_sidebarIconBadge: Badge, generation: 2 })),
      ),
    ).toBe(false);
    expect(isSameSidebarNavigationItem(base, itemFor(panel()))).toBe(false);
  });
});
