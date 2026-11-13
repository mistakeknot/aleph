import { describe, expect, it } from "vitest";
import { parseReturnTime } from "./return-time";

describe("return time parsing", () => {
  const now = Date.parse("2026-02-01T12:00:00.000Z");
  it("accepts inclusive bounds and resolves the next UTC clock occurrence", () => {
    expect(parseReturnTime("in 1m", now)).toBe("2026-02-01T12:01:00.000Z");
    expect(parseReturnTime("in 30d", now)).toBe("2026-03-03T12:00:00.000Z");
    expect(parseReturnTime("at 14:00 UTC", now)).toBe(
      "2026-02-01T14:00:00.000Z",
    );
    expect(parseReturnTime("at 11:00 UTC", now)).toBe(
      "2026-02-02T11:00:00.000Z",
    );
  });
  it.each([
    "2026-02-30T12:00:00Z",
    "2026-02-02T12:00:00",
    "at 25:00 UTC",
    "in 0.5m",
    "in 31d",
  ])("rejects invalid or out of range input %s", (input) => {
    expect(() => parseReturnTime(input, now)).toThrow();
  });
});
