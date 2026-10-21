import { describe, expect, it } from "vitest";
import { accentAt, layerAccent } from "./accent";

describe("layerAccent", () => {
  it.each([
    ["A", "#b9a5fc"],
    ["B", "#c29dfb"],
    ["C", "#ca95fb"],
    ["D", "#d38dfa"],
    ["E", "#db85fa"],
    ["F", "#e47df9"],
    ["G", "#e67fed"],
    ["H", "#e38cd5"],
    ["I", "#e099bc"],
    ["J", "#dca6a4"],
    ["K", "#d9b38c"],
    ["X", "#d9b38c"],
    ["STUDIO", "#d9b38c"],
    [null, "#d9b38c"],
    ["unknown", "#d9b38c"],
  ])("maps %s to %s", (letter, accent) => {
    expect(layerAccent(letter)).toBe(accent);
  });

  it("ignores letter case", () => {
    expect(layerAccent("c")).toBe(layerAccent("C"));
  });
});

describe("accentAt", () => {
  it.each([
    [-1, "#b9a5fc"],
    [0, "#b9a5fc"],
    [0.55, "#e879f9"],
    [1, "#d9b38c"],
    [2, "#d9b38c"],
  ])("maps %s to %s", (t, accent) => {
    expect(accentAt(t)).toBe(accent);
  });
});
