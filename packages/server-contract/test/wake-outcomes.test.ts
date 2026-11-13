import { describe, expect, it } from "vitest";
import { wakeOutcomesResponseSchema } from "../src/index.js";

const report = {
  outcomes: [],
  truncated: false,
  summary: {
    completedTurns: 0,
    unknownCauseRate: null,
    unknownEffectRate: null,
  },
};

describe("wake outcome paging response", () => {
  it.each([null, "opaque-next-page"])(
    "preserves the explicit continuation %s",
    (nextCursor) => {
      const value = { ...report, nextCursor };
      expect(wakeOutcomesResponseSchema.parse(value)).toEqual(value);
    },
  );

  it.each([undefined, 17, {}, []])(
    "rejects a missing or invalid continuation %s",
    (nextCursor) => {
      expect(
        wakeOutcomesResponseSchema.safeParse({ ...report, nextCursor }).success,
      ).toBe(false);
    },
  );

  it("rejects pages larger than 100 even when every outcome is valid", () => {
    const outcome = {
      turnId: "turn-1",
      completed: true,
      wakeCause: "unknown",
      wakeRef: null,
      wakeSources: [],
      wakeSourcesTruncated: false,
      requestsTruncated: false,
      toolCount: null,
      changedAnything: "unknown",
      effectKinds: [],
      coverage: {
        tools: "unknown",
        effects: "unknown",
        attribution: "unknown",
      },
      requests: [],
    };
    const page = {
      ...report,
      nextCursor: "opaque-next-page",
      truncated: true,
      outcomes: Array.from({ length: 100 }, (_, index) => ({
        ...outcome,
        turnId: `turn-${index}`,
      })),
    };
    expect(wakeOutcomesResponseSchema.safeParse(page).success).toBe(true);
    expect(
      wakeOutcomesResponseSchema.safeParse({
        ...page,
        outcomes: [...page.outcomes, outcome],
      }).success,
    ).toBe(false);
  });
});
