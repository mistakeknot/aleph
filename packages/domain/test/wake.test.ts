import { describe, expect, it } from "vitest";
import { mergeWakeProvenance, readWake, wakeAttribution } from "../src/wake.js";

describe("wake provenance", () => {
  it("reads legacy and future causes as unknown but rejects invalid writes", () => {
    expect(readWake({})).toEqual({ wakeCause: "unknown", wakeRef: null });
    expect(readWake({ wakeCause: "future", wakeRef: "opaque" })).toEqual({
      wakeCause: "unknown",
      wakeRef: "opaque",
    });
    expect(() => wakeAttribution({ wakeRef: "x".repeat(201) })).toThrow();
  });
  it("preserves mixed sources and bounds overflow with unknown attribution", () => {
    const first = mergeWakeProvenance(null, {
      wakeCause: "card_pick",
      wakeRef: "pick",
    });
    const mixed = mergeWakeProvenance(first, {
      wakeCause: "timer",
      wakeRef: "deadline",
    });
    expect(mixed).toMatchObject({
      wakeCause: "unknown",
      wakeRef: "pick",
      truncated: false,
      sources: [
        { wakeCause: "card_pick", wakeRef: "pick" },
        { wakeCause: "timer", wakeRef: "deadline" },
      ],
    });
    let overflow = first;
    for (let i = 0; i < 40; i++)
      overflow = mergeWakeProvenance(overflow, {
        wakeCause: "card_pick",
        wakeRef: String(i),
      });
    expect(overflow).toMatchObject({
      wakeCause: "unknown",
      wakeRef: "pick",
      truncated: true,
    });
    expect(overflow.sources).toHaveLength(32);
  });

  it("bounds incoming aggregate sources and explicitly marks lost coverage while retaining the primary ref", () => {
    const wakeSources = Array.from({ length: 40 }, (_, index) => ({
      wakeCause: "card_pick" as const,
      wakeRef: `pick-${index}`,
    }));
    const result = wakeAttribution({
      wakeCause: "card_pick",
      wakeRef: "pick-0",
      wakeSources,
    });
    expect(result).toMatchObject({
      wakeCause: "unknown",
      wakeRef: "pick-0",
      wakeSourcesTruncated: true,
      wakeSources: wakeSources.slice(0, 32),
    });
    expect(wakeAttribution(result)).toEqual(result);
  });

  it("does not replace a missing primary ref with a later ref", () => {
    const first = mergeWakeProvenance(null, { wakeCause: "message" });
    expect(
      mergeWakeProvenance(first, { wakeCause: "timer", wakeRef: "later" }),
    ).toMatchObject({
      wakeCause: "unknown",
      wakeRef: null,
    });
  });
});
