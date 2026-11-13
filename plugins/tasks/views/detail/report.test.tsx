// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ReportSection } from "./report.js";

afterEach(cleanup);

it.each([
  ["done", null, true],
  ["done", "", true],
  ["done", "  \n", true],
  ["done", "Checked: https://example.test/proof", false],
  ["canceled", null, false],
  ["todo", null, false],
  ["in_progress", null, false],
  ["in_review", null, false],
  ["backlog", null, false],
] as const)("marks %s with report %s: %s", (status, report, missing) => {
  const view = render(
    <ReportSection status={status} report={report}>
      Result
    </ReportSection>,
  );
  expect(view.queryByText("Closed without a report") !== null).toBe(missing);
  expect(view.getByText("Result")).toBeTruthy();
});
