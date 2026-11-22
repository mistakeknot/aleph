// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, it, expect } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("./app.js"));
afterEach(cleanup);
it("keeps loss warnings next to the read-only diff", async () => {
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        diff: () => ({
          changes: [{ section: "agents", entry: "claude", kind: "changed" }],
          unsupported: ["warning: unknown scalar omitted"],
        }),
      },
    },
  );
  fireEvent.click(slot.getByRole("button", { name: "Diff" }));
  expect(await slot.findByText("warning: unknown scalar omitted")).toBeTruthy();
  expect(slot.getByText("agents changed claude")).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Apply" })).toBeNull();
  expect(
    slot.getAllByText(/Unknown scalar settings are omitted/).length,
  ).toBeGreaterThan(0);
});
