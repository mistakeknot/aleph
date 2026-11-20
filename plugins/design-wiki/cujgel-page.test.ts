import { describe, expect, it } from "vitest";
import { parseCujgelPage } from "./cujgel-page.js";

const spec = {
  cuj_id: "sample-open-notebook",
  version: "1.0",
  actor: "Reader",
  trigger: "Open",
  steps: [{ step: "Read", build_surface: ["Notebook"] }],
  mental_model: "My words\n  stay mine",
  success_condition: "I recognize it",
  ambiguity_ledger: {
    closed_decisions: [{ decision: "Keep words", confidence: "leaning" }],
    open_questions: [{ question: "Which order?", gate: "must_stop" }],
  },
  evidence: [
    {
      source: "../outside",
      quote: "**Ruled: SAMPLE-123**",
      assumption_tested: "Readable",
    },
  ],
};

describe("native CUJ specs", () => {
  it("projects stable identity, native metadata and only ledger claims", () => {
    const parsed = parseCujgelPage({
      path: "docs/cujs/nested/sample.json",
      content: JSON.stringify(spec),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.page.id).toBe("cujgel:sample-open-notebook");
    expect(parsed.page.updated).toBeNull();
    expect(parsed.page.card).toBeNull();
    expect(parsed.page.pageSource).toEqual({
      type: "cujgel",
      status: "unspecified",
      version: "1.0",
    });
    expect(parsed.page.claims.map((c) => c.status)).toEqual([
      "design-choice",
      "open",
    ]);
    expect(parsed.page.claims.every((c) => c.cards.length === 0)).toBe(true);
    expect(parsed.page.body).toContain("My words\n  stay mine");
  });
  it.each([
    "{",
    JSON.stringify({ ...spec, extra: "unknown" }),
    JSON.stringify({ ...spec, steps: [] }),
    JSON.stringify({
      ...spec,
      ambiguity_ledger: {
        open_questions: [{ question: "?", gate: "invented" }],
      },
    }),
  ])("rejects malformed or unsupported input", (content) => {
    expect(parseCujgelPage({ path: "docs/cujs/sample.json", content }).ok).toBe(
      false,
    );
  });
});
