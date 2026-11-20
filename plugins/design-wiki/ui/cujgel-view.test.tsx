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

it("keeps ledger URLs, emails and ruled-looking prose literal", () => {
  const text =
    "See https://example.invalid/x or ask reader@example.invalid. Ruled — DEMO-123: **Ruled: DEMO-456** with `code` and _emphasis_.";
  const parsed = parseCujgelPage({
    path: "docs/cujs/ledger.json",
    content: JSON.stringify({
      cuj_id: "sample-ledger-page",
      version: "1.0",
      actor: "Reader",
      trigger: "Open",
      steps: [{ step: "Read" }],
      mental_model: "Mine",
      success_condition: "Recognized",
      ambiguity_ledger: { closed_decisions: [text], open_questions: [text] },
    }),
  });
  if (!parsed.ok) throw new Error("fixture rejected");
  const view = render(<WikiPageView page={parsed.page} />);
  expect(view.container.querySelectorAll("a")).toHaveLength(0);
  expect(parsed.page.claims.map((claim) => claim.status)).toEqual([
    "design-choice",
    "open",
  ]);
  expect(parsed.page.claims.every((claim) => claim.cards.length === 0)).toBe(
    true,
  );
  expect(view.container.querySelectorAll("strong")).toHaveLength(2);
  expect(view.container.textContent).toContain(text);
});
