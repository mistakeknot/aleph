import { describe, expect, it } from "vitest";
import { pacificDay, shiftDay } from "./blocker-push.js";

describe("pacificDay", () => {
  it.each([
    ["2026-06-10T06:59:59Z", "2026-06-09"],
    ["2026-06-10T07:00:00Z", "2026-06-10"],
    ["2026-11-01T07:00:00Z", "2026-11-01"],
    ["2026-11-02T07:59:59Z", "2026-11-01"],
    ["2026-11-02T08:00:00Z", "2026-11-02"],
    ["2027-03-14T07:59:59Z", "2027-03-13"],
    ["2027-03-14T08:00:00Z", "2027-03-14"],
    ["2027-03-15T06:59:59Z", "2027-03-14"],
    ["2027-03-15T07:00:00Z", "2027-03-15"],
    ["2026-12-31T23:59:59Z", "2026-12-31"],
    ["2027-01-01T07:59:59Z", "2026-12-31"],
    ["2027-01-01T08:00:00Z", "2027-01-01"],
  ])("maps %s to %s", (instant, day) => {
    expect(pacificDay(Date.parse(instant))).toBe(day);
  });
});

describe("shiftDay", () => {
  it("moves across month, year, and leap-day boundaries", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftDay("2027-01-01", -1)).toBe("2026-12-31");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2026-06-14", -13)).toBe("2026-06-01");
  });
});
