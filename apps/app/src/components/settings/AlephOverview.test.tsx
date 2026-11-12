// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AlephOverviewView } from "./AlephOverview";
afterEach(cleanup);

it("shows unknown sources truthfully and omits the desktop on web", () => {
  render(
    <AlephOverviewView
      desktopVersion={null}
      runningVersion="0.49.0+aleph.1"
      overview={undefined}
      onRefresh={vi.fn()}
      refreshing={false}
      server={<div>Server</div>}
    />,
  );
  expect(screen.queryByText("Desktop")).toBeNull();
  expect(screen.getByText("Qualification status unavailable")).toBeTruthy();
  expect(screen.getByText("Sync status unavailable")).toBeTruthy();
  expect(screen.queryByText(/No release has been qualified/)).toBeNull();
});

it("shows version differences without compatibility claims and refreshes", () => {
  const refresh = vi.fn();
  render(
    <AlephOverviewView
      desktopVersion="0.45.0+aleph.0.6.1"
      runningVersion="0.49.0+aleph.1"
      overview={undefined}
      onRefresh={refresh}
      refreshing={false}
      server={<div>Server</div>}
    />,
  );
  expect(
    screen.getByText("Your desktop and server run different versions"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  expect(refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("Update options"));
  expect(screen.getByText(/Self-update not available yet/)).toBeTruthy();
});

it("renders qualified but unpublished fixture evidence with visible upstream summary", async () => {
  const { AlephOverviewFixture } = await import("./AlephOverview.fixture");
  render(
    <div dir="rtl">
      <AlephOverviewFixture populated />
    </div>,
  );
  expect(
    screen.getByText(/Qualification passed for 0.49.0\+aleph.1/),
  ).toBeTruthy();
  expect(screen.getByText("Automatic update feed not configured")).toBeTruthy();
  expect(screen.getByText(/103 first-parent commits/)).toBeTruthy();
  expect(screen.getByText("Sync status: integrating")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Request server update" }),
  ).toBeNull();
});
