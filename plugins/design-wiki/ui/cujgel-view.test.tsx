// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WikiPageView } from "./wiki-page-view.js";
import { parseCujgelPage } from "../cujgel-page.js";
afterEach(cleanup);
it("renders native metadata and verbatim unsafe prose without cards, links or dates", () => {
  const parsed = parseCujgelPage({
    path: "docs/cujs/sample.json",
    content: JSON.stringify({
      cuj_id: "sample-read-page",
      version: "2.0",
      status: "superseded",
      actor: "Reader",
      trigger: "Open",
      steps: [{ step: "Read" }],
      mental_model: "Mine\n  exactly",
      success_condition: "Recognized",
      evidence: [
        { source: "javascript:alert(1)", quote: "**Ruled: DEMO-123**" },
      ],
    }),
  });
  if (!parsed.ok) throw new Error("fixture rejected");
  const view = render(<WikiPageView page={parsed.page} />);
  expect(screen.getByText(/Cujgel · superseded/)).toBeTruthy();
  expect(view.container.querySelectorAll("a")).toHaveLength(0);
  expect(screen.queryByText("updated")).toBeNull();
  expect(view.container.textContent).toContain("Mine\n  exactly");
  expect(view.container.textContent).toContain("**Ruled: DEMO-123**");
});
