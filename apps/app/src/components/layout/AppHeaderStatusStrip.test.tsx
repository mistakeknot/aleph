// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginAppHeaderStatusProps } from "@get-bb/plugin-sdk";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import {
  removePluginSlotRegistrations,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";
import { AppHeaderStatusStrip } from "./AppHeaderStatusStrip";

function StatusFixture({
  availableWidth,
  isCompactViewport,
}: PluginAppHeaderStatusProps) {
  return (
    <output data-testid="status-fixture">
      {availableWidth}/{isCompactViewport ? "compact" : "wide"}
    </output>
  );
}

const resizeCallbacks: ResizeObserverCallback[] = [];
let observedElements: Element[] = [];

function stubResizeObserver() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeCallbacks.push(callback);
      }
      observe(element: Element) {
        observedElements.push(element);
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

function resizeStrip(width: number) {
  act(() => {
    for (const callback of resizeCallbacks) {
      callback(
        [{ contentRect: { width } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    }
  });
}

function registerStatus(pluginId = "account-pool") {
  act(() => {
    setPluginSlotRegistrations(
      pluginId,
      registrationSet({
        appHeaderStatuses: [
          { id: "status", title: "Account Pooler", component: StatusFixture },
        ],
      }),
    );
  });
}

function tree() {
  return (
    <MemoryRouter>
      <AppHeaderStatusStrip
        threadId={null}
        projectId={null}
        isCompactViewport={false}
      />
    </MemoryRouter>
  );
}

afterEach(() => {
  resizeCallbacks.length = 0;
  observedElements = [];
  vi.unstubAllGlobals();
  cleanup();
  resetAllCrashedPluginSlotsForTest();
  resetPluginSlotStoreForTest();
});

describe("AppHeaderStatusStrip", () => {
  it("renders nothing when no plugin has registered a status", () => {
    render(tree());

    expect(screen.queryByTestId("app-header-status-strip")).toBeNull();
  });

  it("measures a genuine width budget rather than its own collapsed content size", () => {
    stubResizeObserver();
    registerStatus();
    render(tree());

    expect(screen.getByTestId("status-fixture").textContent).toBe("0/wide");

    resizeStrip(480);

    expect(screen.getByTestId("status-fixture").textContent).toBe("480/wide");
  });

  it("attaches the observer once a plugin registers after first paint, not only at mount", () => {
    stubResizeObserver();
    render(tree());

    expect(screen.queryByTestId("app-header-status-strip")).toBeNull();
    expect(observedElements).toHaveLength(0);

    registerStatus();

    expect(screen.getByTestId("app-header-status-strip")).toBeDefined();
    expect(observedElements).toHaveLength(1);

    resizeStrip(320);

    expect(screen.getByTestId("status-fixture").textContent).toBe("320/wide");
  });

  it("re-attaches the observer after every registration unmounts and a new one appears", () => {
    stubResizeObserver();
    registerStatus();
    render(tree());
    resizeStrip(300);
    expect(screen.getByTestId("status-fixture").textContent).toBe("300/wide");

    act(() => {
      removePluginSlotRegistrations("account-pool");
    });
    expect(screen.queryByTestId("app-header-status-strip")).toBeNull();

    registerStatus("other-plugin");

    expect(screen.getByTestId("app-header-status-strip")).toBeDefined();
    resizeStrip(200);
    expect(screen.getByTestId("status-fixture").textContent).toBe("200/wide");
  });

  it("divides the available width evenly across every current contribution, net of the gap between them", () => {
    stubResizeObserver();
    registerStatus("account-pool");
    registerStatus("other-plugin");
    render(tree());

    resizeStrip(300);

    const fixtures = screen.getAllByTestId("status-fixture");
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0]?.textContent).toBe("146/wide");
    expect(fixtures[1]?.textContent).toBe("146/wide");
  });

  it("advertises a budget each contribution can actually occupy without overflowing the strip", () => {
    stubResizeObserver();
    registerStatus("account-pool");
    registerStatus("other-plugin");
    render(tree());

    resizeStrip(400);

    const fixtures = screen.getAllByTestId("status-fixture");
    const perContributionWidth = Number(
      fixtures[0]?.textContent?.split("/")[0],
    );
    const contributionCount = fixtures.length;
    const gapBetweenContributions = 8;
    const totalOccupied =
      perContributionWidth * contributionCount +
      gapBetweenContributions * (contributionCount - 1);
    expect(totalOccupied).toBeLessThanOrEqual(400);
  });

  it("labels each contribution's wrapper region with its registration title", () => {
    stubResizeObserver();
    registerStatus();
    render(tree());

    expect(screen.getByRole("group", { name: "Account Pooler" })).toBeDefined();
  });
});
