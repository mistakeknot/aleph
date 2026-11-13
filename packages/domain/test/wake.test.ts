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
      wakeRef: null,
      truncated: true,
    });
    expect(overflow.sources).toHaveLength(32);
  });
});
