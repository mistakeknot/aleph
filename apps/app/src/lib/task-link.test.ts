// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildTaskLinkPluginPanelRequest,
  isMarkdownTaskSchemeHref,
  parseMarkdownTaskLinkHref,
  TASK_THREAD_PANEL_ACTION_ID,
  TASKS_PLUGIN_ID,
} from "./task-link";

describe("parseMarkdownTaskLinkHref", () => {
  it("parses a bbtask:// scheme href", () => {
    expect(parseMarkdownTaskLinkHref("bbtask://MSQ-22")).toEqual({
      taskKey: "MSQ-22",
    });
  });

  it("decodes an encoded task key in a bbtask:// scheme href", () => {
    expect(parseMarkdownTaskLinkHref("bbtask://MSQ%2022")).toEqual({
      taskKey: "MSQ 22",
    });
  });

  it("rejects a bbtask:// scheme href with no task key", () => {
    expect(parseMarkdownTaskLinkHref("bbtask://")).toBeNull();
  });

  it("parses a relative task panel app-route href", () => {
    expect(
      parseMarkdownTaskLinkHref("/plugins/tasks/tasks/task/MSQ-22"),
    ).toEqual({ taskKey: "MSQ-22" });
  });

  it("parses an absolute app-origin task panel href", () => {
    const href = `${window.location.origin}/plugins/tasks/tasks/task/MSQ-22`;
    expect(parseMarkdownTaskLinkHref(href)).toEqual({ taskKey: "MSQ-22" });
  });

  it("rejects a task panel href on a different origin", () => {
    expect(
      parseMarkdownTaskLinkHref(
        "https://evil.example/plugins/tasks/tasks/task/MSQ-22",
      ),
    ).toBeNull();
  });

  it("rejects an unrelated plugin panel href", () => {
    expect(parseMarkdownTaskLinkHref("/plugins/tasks/tasks/manage")).toBeNull();
  });

  it("returns null for an empty or undefined href", () => {
    expect(parseMarkdownTaskLinkHref("")).toBeNull();
    expect(parseMarkdownTaskLinkHref(undefined)).toBeNull();
  });
});

describe("isMarkdownTaskSchemeHref", () => {
  it("recognizes a bbtask:// scheme href", () => {
    expect(isMarkdownTaskSchemeHref("bbtask://MSQ-22")).toBe(true);
  });

  it("rejects a non-bbtask href", () => {
    expect(isMarkdownTaskSchemeHref("/plugins/tasks/tasks/task/MSQ-22")).toBe(
      false,
    );
    expect(isMarkdownTaskSchemeHref("https://example.com")).toBe(false);
  });
});

describe("buildTaskLinkPluginPanelRequest", () => {
  it("builds a plugin panel request for a task link", () => {
    expect(
      buildTaskLinkPluginPanelRequest("/plugins/tasks/tasks/task/MSQ-22"),
    ).toEqual({
      actionId: TASK_THREAD_PANEL_ACTION_ID,
      params: { taskKey: "MSQ-22" },
      pluginId: TASKS_PLUGIN_ID,
      title: "MSQ-22",
    });
  });

  it("returns null for a non-task href", () => {
    expect(buildTaskLinkPluginPanelRequest("https://example.com")).toBeNull();
  });
});
